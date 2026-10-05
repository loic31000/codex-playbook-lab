import crypto from 'node:crypto';
import http from 'node:http';

import { checkedProcess } from './process.mjs';
import { dockerExec } from './docker-environment.mjs';

const FETCH_SCRIPT = `
const [url, expected] = process.argv.slice(1);
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  if (expected && body !== expected) process.exit(3);
  process.stdout.write(String(response.status));
} catch {
  process.exit(4);
}
`;

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function resolveName(environment, hostname) {
  const result = await dockerExec(environment, ['getent', 'hosts', hostname], { timeoutMs: 10_000 });
  if (result.code === 0 && result.stdout.trim()) {
    return {
      status: 'reachable',
      addresses: [...new Set(lines(result.stdout).map((line) => line.split(/\s+/)[0]))],
    };
  }
  if (result.code === 2) return { status: 'blocked', addresses: [] };
  return { status: 'not_proven', addresses: [] };
}

async function fetchFromContainer(environment, url, expected = '') {
  try {
    const result = await dockerExec(environment, ['node', '-e', FETCH_SCRIPT, url, expected], { timeoutMs: 10_000 });
    if (result.code === 0) return { status: 'reachable', httpStatus: Number(result.stdout.trim()) || null };
    if (result.code === 4) return { status: 'blocked', httpStatus: null };
    return { status: 'not_proven', httpStatus: null };
  } catch {
    return { status: 'not_proven', httpStatus: null };
  }
}

function fromRouteHex(value) {
  if (!/^[0-9A-F]{8}$/i.test(value)) return null;
  return [6, 4, 2, 0].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).join('.');
}

async function collectRoutes(environment) {
  const result = await dockerExec(environment, ['cat', '/proc/net/route'], { timeoutMs: 10_000 });
  if (result.code !== 0) return { status: 'not_proven', entries: [] };
  const entries = lines(result.stdout).slice(1).map((line) => {
    const [interfaceName, destination, gateway, flags, , , metric, mask] = line.split(/\s+/);
    return {
      interface: interfaceName,
      destination: fromRouteHex(destination),
      gateway: fromRouteHex(gateway),
      mask: fromRouteHex(mask),
      flags,
      metric: Number(metric),
    };
  });
  return { status: entries.length ? 'reachable' : 'not_proven', entries };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

export async function collectNetworkProbe(environment) {
  const sentinel = `NETWORK_SENTINEL_${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === '/probe' ? 200 : 404, {
      'content-type': 'text/plain',
      'cache-control': 'no-store',
    });
    response.end(request.url === '/probe' ? sentinel : 'not found');
  });
  const port = await listen(server);
  try {
    const [hostResolution, gatewayResolution, networkInspect, routes] = await Promise.all([
      resolveName(environment, 'host.docker.internal'),
      resolveName(environment, 'gateway.docker.internal'),
      checkedProcess('docker', ['network', 'inspect', environment.network]),
      collectRoutes(environment),
    ]);
    const network = JSON.parse(networkInspect.stdout)[0];
    const hostHttp = hostResolution.status === 'reachable'
      ? await fetchFromContainer(environment, `http://host.docker.internal:${port}/probe`, sentinel)
      : { status: 'not_proven', httpStatus: null };
    const internet = await fetchFromContainer(environment, 'https://example.com/');
    return {
      dns: {
        hostDockerInternal: hostResolution,
        gatewayDockerInternal: gatewayResolution,
      },
      hostHttp,
      internet: { ...internet, destination: 'example.com' },
      dockerNetwork: {
        driver: network.Driver,
        internal: network.Internal,
        attachable: network.Attachable,
        ingress: network.Ingress,
        ipam: (network.IPAM?.Config ?? []).map(({ Subnet, Gateway }) => ({ subnet: Subnet, gateway: Gateway })),
      },
      routes,
    };
  } finally {
    await close(server);
  }
}
