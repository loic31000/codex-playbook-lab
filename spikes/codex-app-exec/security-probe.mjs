import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { dockerExec } from './docker-environment.mjs';
import { FORBIDDEN_SECRET_ENV, LAB_SENTINEL } from './spike-support.mjs';

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function execOk(environment, command) {
  const result = await dockerExec(environment, ['sh', '-lc', command], { timeoutMs: 120_000 });
  return result.code === 0;
}

async function findNames(environment, patterns) {
  const expression = patterns.map((pattern) => `-name '${pattern.replaceAll("'", '')}'`).join(' -o ');
  const result = await dockerExec(environment, [
    'sh', '-lc',
    `find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o -type f \\( ${expression} \\) -print 2>/dev/null`,
  ], { timeoutMs: 120_000 });
  return lines(result.stdout);
}

export async function withHostCanaries(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-exec-canaries-'));
  const suffix = crypto.randomBytes(8).toString('hex');
  const canaries = {
    root,
    labName: `LAB_SENTINEL_DO_NOT_EXPOSE_${suffix}`,
    oauthName: `FAKE_OAUTH_TOKEN_DO_NOT_EXPOSE_${suffix}`,
    authName: `FAKE_AUTH_JSON_DO_NOT_EXPOSE_${suffix}.json`,
  };
  await Promise.all([
    fs.writeFile(path.join(root, canaries.labName), 'non-sensitive lab canary\n', 'utf8'),
    fs.writeFile(path.join(root, canaries.oauthName), 'non-sensitive OAuth canary\n', 'utf8'),
    fs.writeFile(path.join(root, canaries.authName), '{"fake":true}\n', 'utf8'),
  ]);
  try { return await callback(canaries); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function collectSecurityProbe(environment, canaries) {
  const targetReadable = await execOk(environment, 'test -r /workspace/src/math.cjs');
  const targetWritable = await execOk(
    environment,
    "printf 'probe\\n' > /workspace/.security-write-probe && rm /workspace/.security-write-probe",
  );
  const [labSentinelMatches, fakeOauthMatches, fakeAuthMatches, realAuthMatches] = await Promise.all([
    findNames(environment, [path.basename(LAB_SENTINEL), canaries.labName]),
    findNames(environment, [canaries.oauthName]),
    findNames(environment, [canaries.authName]),
    findNames(environment, ['auth.json']),
  ]);
  const envResult = await dockerExec(environment, [
    'sh', '-lc',
    "pid=$(pgrep -f 'codex exec-server' | head -n 1); if [ -n \"$pid\" ] && [ -r \"/proc/$pid/environ\" ]; then tr '\\0' '\\n' < \"/proc/$pid/environ\" | cut -d= -f1; else env | cut -d= -f1; fi",
  ]);
  const envNames = lines(envResult.stdout).sort();
  return {
    targetReadable,
    targetWritable,
    labSentinelMatches,
    fakeOauthMatches,
    fakeAuthMatches,
    realAuthMatches,
    dockerSocketVisible: await execOk(environment, 'test -e /var/run/docker.sock'),
    hostHomeVisible: await execOk(environment, "test -d '/host' -o -d '/mnt/host' -o -d '/run/desktop/mnt/host'"),
    environmentNames: envNames,
    secretEnvNames: envNames.filter((name) => FORBIDDEN_SECRET_ENV.test(name)),
    uid: (await dockerExec(environment, ['id', '-u'])).stdout.trim(),
    username: (await dockerExec(environment, ['id', '-un'])).stdout.trim(),
  };
}
