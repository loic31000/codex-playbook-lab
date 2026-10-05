import crypto from 'node:crypto';
import http from 'node:http';

import { checkedProcess } from './process.mjs';
import { dockerExec } from './docker-environment.mjs';

const REQUEST_SCRIPT = String.raw`
const [mode, target, expected = ''] = process.argv.slice(1);
const blocked = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN']);
function finish(status, detail = null) {
  process.stdout.write(JSON.stringify({ status, detail }));
}
if (mode === 'fetch') {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    finish('reachable', { httpStatus: response.status, expectedContent: !expected || body === expected });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown';
    finish(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'not_proven' : blocked.has(code) ? 'blocked' : 'not_proven', { code });
  }
} else {
  const { default: net } = await import('node:net');
  const [host, portText] = target.split('|');
  const socket = net.createConnection({ host, port: Number(portText) });
  let settled = false;
  const done = (status, code) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    finish(status, { code });
  };
  socket.setTimeout(3000, () => done('not_proven', 'timeout'));
  socket.once('connect', () => done('reachable', 'connected'));
  socket.once('error', (error) => done(blocked.has(error.code) ? 'blocked' : 'reachable', error.code));
}
`;

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function classifyProbeResult(result) {
  if (result?.timedOut === true) return { status: 'not_proven', detail: { code: 'timeout' } };
  if (result?.code !== 0) return { status: 'not_proven', detail: { code: `exit_${result?.code ?? 'unknown'}` } };
  try {
    const parsed = JSON.parse(result.stdout);
    if (['reachable', 'blocked', 'not_proven'].includes(parsed.status)) return parsed;
  } catch {}
  return { status: 'not_proven', detail: { code: 'invalid_probe_output' } };
}

async function resolveName(environment, hostname) {
  try {
    const result = await dockerExec(environment, ['getent', 'hosts', hostname], { timeoutMs: 5_000 });
    if (result.code === 0 && result.stdout.trim()) {
      return {
        status: 'reachable',
        mechanism: 'resolved',
        addresses: [...new Set(lines(result.stdout).map((line) => line.split(/\s+/)[0]))],
      };
    }
    if (result.code === 2) return { status: 'blocked', mechanism: 'unresolved', addresses: [] };
    return { status: 'not_proven', mechanism: `getent_exit_${result.code}`, addresses: [] };
  } catch {
    return { status: 'not_proven', mechanism: 'timeout_or_probe_error', addresses: [] };
  }
}

async function requestProbe(environment, mode, target, expected = '') {
  try {
    const result = await dockerExec(
      environment,
      ['node', '-e', REQUEST_SCRIPT, mode, target, expected],
      { timeoutMs: 7_000 },
    );
    return classifyProbeResult(result);
  } catch {
    return { status: 'not_proven', detail: { code: 'outer_timeout_or_probe_error' } };
  }
}

function fromRouteHex(value) {
  if (!/^[0-9A-F]{8}$/i.test(value)) return null;
  return [6, 4, 2, 0].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).join('.');
}

async function collectRoutes(environment) {
  const [ipv4, ipv6] = await Promise.all([
    dockerExec(environment, ['cat', '/proc/net/route'], { timeoutMs: 5_000 }),
    dockerExec(environment, ['cat', '/proc/net/ipv6_route'], { timeoutMs: 5_000 }),
  ]);
  if (ipv4.code !== 0 || ipv6.code !== 0) return { status: 'not_proven', ipv4: [], ipv6: [] };
  const ipv4Entries = lines(ipv4.stdout).slice(1).map((line) => {
    const [interfaceName, destination, gateway, flags, , , metric, mask] = line.split(/\s+/);
    return {
      interface: interfaceName,
      destination: fromRouteHex(destination),
      gateway: fromRouteHex(gateway),
      mask: fromRouteHex(mask),
      flags,
      metric: Number(metric),
    };
  }).filter((entry) => entry.interface !== 'lo');
  const ipv6Entries = lines(ipv6.stdout).map((line) => {
    const fields = line.split(/\s+/);
    return { destination: fields[0], prefixLength: fields[1], gateway: fields[4], interface: fields[9] };
  }).filter((entry) => entry.interface !== 'lo');
  return {
    status: ipv4Entries.length || ipv6Entries.length ? 'reachable' : 'blocked',
    mechanism: ipv4Entries.length || ipv6Entries.length ? 'routes_present' : 'no_routes',
    ipv4: ipv4Entries,
    ipv6: ipv6Entries,
  };
}

async function collectInterfaces(environment) {
  const script = "const os=require('node:os');process.stdout.write(JSON.stringify(os.networkInterfaces()))";
  const result = await dockerExec(environment, ['node', '-e', script], { timeoutMs: 5_000 });
  if (result.code !== 0) return { status: 'not_proven', names: [] };
  const interfaces = JSON.parse(result.stdout);
  return {
    status: 'reachable',
    names: Object.keys(interfaces).sort(),
    nonLoopback: Object.entries(interfaces).flatMap(([name, addresses]) => (
      addresses.filter((address) => !address.internal).map((address) => ({ name, family: address.family, address: address.address }))
    )),
  };
}

async function collectResolvConf(environment) {
  const result = await dockerExec(environment, ['cat', '/etc/resolv.conf'], { timeoutMs: 5_000 });
  if (result.code !== 0) return { status: 'not_proven', nameservers: [], contentSha256: null };
  return {
    status: 'reachable',
    nameservers: lines(result.stdout)
      .filter((line) => line.startsWith('nameserver '))
      .map((line) => line.split(/\s+/)[1]),
    contentSha256: crypto.createHash('sha256').update(result.stdout).digest('hex'),
  };
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

function blockedByResolution(resolution, mechanism) {
  if (resolution.status === 'blocked') return { status: 'blocked', detail: { code: mechanism } };
  return { status: 'not_proven', detail: { code: mechanism } };
}

export function networkIsolationPassed(report) {
  const publicProbes = Object.values(report.publicDestinations ?? {});
  return report.policy?.networkMode === 'none'
    && report.routes?.status === 'blocked'
    && report.interfaces?.nonLoopback?.length === 0
    && report.dns?.hostDockerInternal?.status === 'blocked'
    && report.dns?.gatewayDockerInternal?.status === 'blocked'
    && report.hostTcp?.status === 'blocked'
    && report.hostHttp?.status === 'blocked'
    && publicProbes.length >= 2
    && publicProbes.every((probe) => (
      probe.dns.status === 'blocked'
      && probe.tcp443.status === 'blocked'
      && probe.http.status === 'blocked'
      && probe.https.status === 'blocked'
    ));
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
    const [inspectResult, routes, interfaces, resolvConf, hostResolution, gatewayResolution] = await Promise.all([
      checkedProcess('docker', ['inspect', environment.container]),
      collectRoutes(environment),
      collectInterfaces(environment),
      collectResolvConf(environment),
      resolveName(environment, 'host.docker.internal'),
      resolveName(environment, 'gateway.docker.internal'),
    ]);
    const inspect = JSON.parse(inspectResult.stdout)[0];
    const hostTcp = hostResolution.status === 'reachable'
      ? await requestProbe(environment, 'tcp', `host.docker.internal|${port}`)
      : blockedByResolution(hostResolution, 'host_name_unresolved');
    const hostHttp = hostResolution.status === 'reachable'
      ? await requestProbe(environment, 'fetch', `http://host.docker.internal:${port}/probe`, sentinel)
      : blockedByResolution(hostResolution, 'host_name_unresolved');
    const destinations = ['example.com', 'www.iana.org'];
    const publicDestinations = {};
    for (const hostname of destinations) {
      const dns = await resolveName(environment, hostname);
      publicDestinations[hostname] = {
        dns,
        tcp443: dns.status === 'reachable'
          ? await requestProbe(environment, 'tcp', `${hostname}|443`)
          : blockedByResolution(dns, 'external_name_unresolved'),
        http: dns.status === 'reachable'
          ? await requestProbe(environment, 'fetch', `http://${hostname}/`)
          : blockedByResolution(dns, 'external_name_unresolved'),
        https: dns.status === 'reachable'
          ? await requestProbe(environment, 'fetch', `https://${hostname}/`)
          : blockedByResolution(dns, 'external_name_unresolved'),
      };
    }
    const report = {
      policy: {
        networkMode: inspect.HostConfig.NetworkMode,
        publishedPorts: inspect.HostConfig.PortBindings ?? {},
      },
      interfaces,
      routes,
      resolvConf,
      dns: {
        hostDockerInternal: hostResolution,
        gatewayDockerInternal: gatewayResolution,
      },
      gatewayDirect: {
        status: routes.ipv4.some((route) => route.gateway && route.gateway !== '0.0.0.0') ? 'not_proven' : 'blocked',
        mechanism: routes.ipv4.length ? 'route_requires_probe' : 'no_gateway_no_route',
      },
      hostTcp,
      hostHttp,
      publicDestinations,
    };
    report.isolationPass = networkIsolationPassed(report);
    return report;
  } finally {
    await close(server);
  }
}
