import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { runCodexVersion } from '../../src/core/codex-process.mjs';
import { checkedProcess, runProcess } from './process.mjs';
import {
  CODEX_VERSION,
  FIXTURE_ROOT,
  IMAGE_NAME,
  LAB_ROOT,
  SPIKE_ROOT,
  FORBIDDEN_SECRET_ENV,
  SensitiveValue,
  assertPinnedCodexVersion,
  mountPolicyViolations,
  sha256,
} from './spike-support.mjs';

const PREFIX = 'codex-app-exec-spike-';

function assertOwnedName(value) {
  if (!value.startsWith(PREFIX) || !/^[a-z0-9-]+$/.test(value)) throw new Error(`Nom Docker non sûr : ${value}`);
}

export async function buildImage() {
  assertPinnedCodexVersion((await runCodexVersion()).stdout);
  const context = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  try {
    await fs.copyFile(path.join(SPIKE_ROOT, 'Dockerfile'), path.join(context, 'Dockerfile'));
    await fs.copyFile(path.join(SPIKE_ROOT, 'entrypoint.sh'), path.join(context, 'entrypoint.sh'));
    await fs.cp(FIXTURE_ROOT, path.join(context, 'fixture'), { recursive: true });
    await checkedProcess('docker', [
      'build', '--pull=false', '--build-arg', `CODEX_VERSION=${CODEX_VERSION}`,
      '--tag', IMAGE_NAME, context,
    ], { timeoutMs: 600_000 });
  } finally {
    await fs.rm(context, { recursive: true, force: true });
  }
}

export async function startEnvironment(label) {
  const suffix = `${label}-${process.pid}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const container = `${PREFIX}${suffix}`;
  const volume = `${container}-workspace`;
  const network = `${container}-network`;
  const execServerCredential = new SensitiveValue(
    crypto.randomBytes(32).toString('base64url'),
    'exec-server-capability-token',
  );
  const execServerCredentialHash = sha256(execServerCredential.reveal());
  for (const name of [container, volume, network]) assertOwnedName(name);
  await checkedProcess('docker', ['volume', 'create', volume]);
  await checkedProcess('docker', ['network', 'create', network]);
  try {
    await checkedProcess('docker', [
      'run', '--detach', '--name', container,
      '--network', network,
      '--publish', '127.0.0.1::4500',
      '--mount', `type=volume,src=${volume},dst=/workspace`,
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--pids-limit', '256', '--memory', '1g', '--cpus', '2',
      '--env', 'HOME=/tmp/home', '--env', 'CODEX_HOME=/tmp/codex-home',
      IMAGE_NAME, execServerCredentialHash,
    ], { timeoutMs: 120_000 });
    const portOutput = await checkedProcess('docker', ['port', container, '4500/tcp']);
    const match = portOutput.stdout.trim().match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error(`Port exec-server inattendu : ${portOutput.stdout.trim()}`);
    const execServerUrl = `ws://127.0.0.1:${match[1]}`;
    const inspect = JSON.parse((await checkedProcess('docker', ['inspect', container])).stdout)[0];
    const mountViolations = mountPolicyViolations(inspect.Mounts, [LAB_ROOT, os.homedir()]);
    if (mountViolations.length) throw new Error(`Mount host interdit : ${mountViolations.join(', ')}`);
    return { container, volume, network, execServerUrl, execServerCredential, inspect };
  } catch (error) {
    await cleanupEnvironment({ container, volume, network });
    throw error;
  }
}

async function waitForTcp(url, timeoutMs = 10_000) {
  const target = new URL(url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Le listener exec-server n’est pas devenu joignable à temps');
}

export async function unauthenticatedWebSocketRejected(execServerUrl) {
  await waitForTcp(execServerUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const websocket = new WebSocket(execServerUrl);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { websocket.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { websocket.close(); } catch {}
      reject(new Error('Handshake WebSocket non authentifié indéterminé'));
    }, 5_000);
    websocket.addEventListener('open', () => finish(false), { once: true });
    websocket.addEventListener('error', () => finish(true), { once: true });
    websocket.addEventListener('close', () => finish(true), { once: true });
  });
}

export async function dockerExec(environment, command, options = {}) {
  return runProcess('docker', ['exec', environment.container, ...command], options);
}

export async function collectContainerFacts(environment) {
  const inspect = environment.inspect;
  const envNames = (inspect.Config.Env ?? []).map((entry) => entry.split('=', 1)[0]).sort();
  return {
    image: inspect.Config.Image,
    mounts: inspect.Mounts.map((mount) => ({
      type: mount.Type,
      name: mount.Name ?? null,
      destination: mount.Destination,
      readWrite: mount.RW,
      sourceKind: mount.Type === 'volume' ? 'docker-volume' : mount.Type,
    })),
    envNames,
    secretEnvNames: envNames.filter((name) => FORBIDDEN_SECRET_ENV.test(name)),
    networkMode: inspect.HostConfig.NetworkMode,
    publishedPorts: inspect.HostConfig.PortBindings,
    user: inspect.Config.User,
    readOnlyRootFilesystem: inspect.HostConfig.ReadonlyRootfs,
    capDrop: inspect.HostConfig.CapDrop ?? [],
    securityOpt: inspect.HostConfig.SecurityOpt ?? [],
    dockerSocketMounted: inspect.Mounts.some((mount) => mount.Destination === '/var/run/docker.sock'),
    websocketAuthentication: 'capability-token-sha256',
  };
}

export async function cleanupEnvironment(environment) {
  if (!environment) return;
  const { container, volume, network } = environment;
  for (const name of [container, volume, network]) assertOwnedName(name);
  await runProcess('docker', ['rm', '--force', container], { timeoutMs: 30_000 });
  await runProcess('docker', ['volume', 'rm', volume], { timeoutMs: 30_000 });
  await runProcess('docker', ['network', 'rm', network], { timeoutMs: 30_000 });
}
