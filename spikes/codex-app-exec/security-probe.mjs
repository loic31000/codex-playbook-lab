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

async function findContent(environment, pattern) {
  if (!/^[A-Z0-9_]+$/.test(pattern)) throw new Error('Sentinelle de contenu invalide');
  const command = [
    'find /',
    "\\( -path /proc -o -path /sys -o -path /dev -o -path /run \\) -prune -o",
    '-type f -readable -print0 2>/dev/null',
    `| xargs -0 -r grep -l -F -- '${pattern}' 2>/dev/null`,
  ].join(' ');
  const result = await dockerExec(environment, ['sh', '-lc', command], { timeoutMs: 120_000 });
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
    labContent: `LAB_CONTENT_DO_NOT_EXPOSE_${suffix.toUpperCase()}`,
    oauthContent: `FAKE_OAUTH_CONTENT_DO_NOT_EXPOSE_${suffix.toUpperCase()}`,
    authContent: `FAKE_AUTH_CONTENT_DO_NOT_EXPOSE_${suffix.toUpperCase()}`,
  };
  await Promise.all([
    fs.writeFile(path.join(root, canaries.labName), `${canaries.labContent}\n`, 'utf8'),
    fs.writeFile(path.join(root, canaries.oauthName), `${canaries.oauthContent}\n`, 'utf8'),
    fs.writeFile(path.join(root, canaries.authName), `${canaries.authContent}\n`, 'utf8'),
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
  const [
    labSentinelMatches, fakeOauthMatches, fakeAuthMatches, realAuthMatches,
    labContentMatches, fakeOauthContentMatches, fakeAuthContentMatches,
  ] = await Promise.all([
    findNames(environment, [path.basename(LAB_SENTINEL), canaries.labName]),
    findNames(environment, [canaries.oauthName]),
    findNames(environment, [canaries.authName]),
    findNames(environment, ['auth.json']),
    findContent(environment, canaries.labContent),
    findContent(environment, canaries.oauthContent),
    findContent(environment, canaries.authContent),
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
    labContentMatches,
    fakeOauthContentMatches,
    fakeAuthContentMatches,
    dockerSocketVisible: await execOk(environment, 'test -e /var/run/docker.sock'),
    hostHomeVisible: await execOk(environment, "test -d '/host' -o -d '/mnt/host' -o -d '/run/desktop/mnt/host'"),
    environmentNames: envNames,
    secretEnvNames: envNames.filter((name) => FORBIDDEN_SECRET_ENV.test(name)),
    uid: (await dockerExec(environment, ['id', '-u'])).stdout.trim(),
    username: (await dockerExec(environment, ['id', '-un'])).stdout.trim(),
  };
}
