import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppServerClient, createTemporaryCodexHome } from '../../spikes/codex-app-exec/app-server-client.mjs';
import {
  REQUESTED_SCOPES,
  RESOURCE,
  buildAuthorizationUrl,
  dpapiProtect,
  dpapiUnprotect,
  requireNoApiKeyEnvironment,
} from '../../spikes/codex-app-exec/chatgpt-oauth.mjs';
import {
  buildImage,
  cleanupEnvironment,
  collectContainerFacts,
  dockerExec,
  startEnvironment,
} from '../../spikes/codex-app-exec/docker-environment.mjs';
import {
  collectRoutingAssertions,
  collectWorkspaceSnapshot,
  runTargetTests,
  summarizeNotifications,
} from '../../spikes/codex-app-exec/evidence.mjs';
import { collectSecurityProbe, withHostCanaries } from '../../spikes/codex-app-exec/security-probe.mjs';
import {
  FIXTURE_ROOT,
  LAB_ROOT,
  SensitiveValue,
  assessSecurityProbe,
  containsSecret,
  mountPolicyViolations,
  redact,
  safeEvidence,
  securityProbePassed,
  treeFingerprint,
} from '../../spikes/codex-app-exec/spike-support.mjs';
import { runProcess } from '../../spikes/codex-app-exec/process.mjs';

const docker = await runProcess('docker', ['info'], { timeoutMs: 30_000 }).catch(() => ({ code: 1 }));
const dockerAvailable = docker.code === 0;

test('fixture déterministe avec test initial rouge', async () => {
  const first = await treeFingerprint(FIXTURE_ROOT);
  const second = await treeFingerprint(FIXTURE_ROOT);
  assert.equal(first, second);
  assert.equal(first, '53426c69f06c00996d3257b793b7d0158cf99649a79c7b2fa5e4f92e8a27a148');
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = await runProcess(process.execPath, ['--test'], {
    cwd: FIXTURE_ROOT,
    env: childEnvironment,
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /7 - 5 !== 12|Expected values to be strictly equal/);
});

test('aucune API key n’est requise et aucun fallback implicite n’est accepté', () => {
  assert.doesNotThrow(() => requireNoApiKeyEnvironment({}));
  assert.throws(() => requireNoApiKeyEnvironment({ OPENAI_API_KEY: 'fake-key-for-test' }), /API key interdite/);
});

test('credentials redacted et non sérialisables en clair', () => {
  const secret = new SensitiveValue('synthetic-secret-value-1234567890', 'test-token');
  assert.equal(JSON.stringify({ secret }), '{"secret":"[REDACTED:test-token]"}');
  assert.equal(String(secret), '[REDACTED:test-token]');
  assert.equal(redact(`Bearer ${secret.reveal()}`, [secret]), 'Bearer [REDACTED]');
  assert.equal(containsSecret({ nested: secret.reveal() }, [secret]), true);
  assert.throws(() => safeEvidence({ leaked: secret.reveal() }, [secret]), /credential/);
});

test('preuves app-server conservent les commandes objectives sans flux de texte volumineux', () => {
  const summary = summarizeNotifications([
    { method: 'item/agentMessage/delta', params: { delta: 'ignored' } },
    {
      method: 'item/completed',
      params: {
        item: {
          id: 'exec-1', type: 'commandExecution', status: 'completed',
          command: 'pwd', cwd: '/workspace', exitCode: 0, durationMs: 12,
          aggregatedOutput: '/workspace\n',
        },
      },
    },
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].item.command, 'pwd');
  assert.equal(summary[0].item.cwd, '/workspace');
  assert.equal(summary[0].item.exitCode, 0);
  assert.match(summary[0].item.outputHash, /^[0-9a-f]{64}$/);
});

test('URL OAuth officielle avec PKCE, resource et scopes directs sans credential', () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: 'dynamic_agent_client',
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    redirectUri: 'http://127.0.0.1:12345/auth/callback',
    state: 'state', nonce: 'nonce', challenge: 'challenge',
  }));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(url.searchParams.get('resource'), RESOURCE);
  assert.deepEqual(url.searchParams.get('scope').split(' '), REQUESTED_SCOPES);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('access_token'), false);
  assert.equal(url.searchParams.has('refresh_token'), false);
});

test('stockage DPAPI Windows effectue un aller-retour sans clair persistant', { skip: process.platform !== 'win32' }, async () => {
  const plaintext = `synthetic-dpapi-${crypto.randomUUID()}`;
  const ciphertext = await dpapiProtect(plaintext);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(ciphertext.includes(plaintext), false);
  assert.equal(await dpapiUnprotect(ciphertext), plaintext);
});

test('policy de mounts refuse Lab, home et Docker socket', () => {
  const mounts = [
    { Type: 'bind', Source: LAB_ROOT, Destination: '/lab' },
    { Type: 'bind', Source: os.homedir(), Destination: '/host-home' },
  ];
  assert.equal(mountPolicyViolations(mounts, [LAB_ROOT, os.homedir()]).length, 2);
  assert.deepEqual(mountPolicyViolations([{ Type: 'volume', Source: '/var/lib/docker/volumes/x' }], [LAB_ROOT]), []);
});

test('security report positif et injections négatives', () => {
  const clean = {
    targetReadable: true, targetWritable: true, labSentinelMatches: [], fakeOauthMatches: [],
    fakeAuthMatches: [], realAuthMatches: [], dockerSocketVisible: false, hostHomeVisible: false,
    secretEnvNames: [],
  };
  assert.equal(securityProbePassed(clean), true);
  for (const mutation of [
    { secretEnvNames: ['ACCESS_TOKEN'] },
    { realAuthMatches: ['/workspace/.codex/auth.json'] },
    { labSentinelMatches: ['/workspace/LAB_SENTINEL_DO_NOT_EXPOSE'] },
    { fakeOauthMatches: ['/tmp/FAKE_OAUTH_TOKEN_DO_NOT_EXPOSE'] },
    { dockerSocketVisible: true },
    { targetReadable: false },
    { targetWritable: false },
  ]) {
    const report = { ...clean, ...mutation };
    assert.equal(securityProbePassed(report), false, JSON.stringify(mutation));
    assert.ok(Object.values(assessSecurityProbe(report)).includes(false));
  }
});

test('Docker target-only, app-server vers exec-server et workspaces A/B', { skip: !dockerAvailable, timeout: 180_000 }, async () => {
  await buildImage();
  const environments = [];
  let client;
  let codexHome;
  try {
    const baseline = await startEnvironment('test-baseline');
    environments.push(baseline);
    const treatment = await startEnvironment('test-treatment');
    environments.push(treatment);
    const [baselineInitial, treatmentInitial] = await Promise.all([
      collectWorkspaceSnapshot(baseline), collectWorkspaceSnapshot(treatment),
    ]);
    assert.equal(baselineInitial.commit, treatmentInitial.commit);
    assert.equal(baselineInitial.tree, treatmentInitial.tree);
    assert.equal(baselineInitial.commit, '96bbdd2cf9cd8b01f21d77759bb8b5b190f4bf44');
    assert.equal(baselineInitial.tree, '3dd7d2e919328ec962f8cb90ea4b2e5c717ff94d');
    assert.equal(baselineInitial.status, '');
    assert.equal(treatmentInitial.status, '');
    assert.notEqual(baseline.volume, treatment.volume);
    assert.equal((await runTargetTests(baseline)).exitCode, 1);

    const facts = await collectContainerFacts(baseline);
    assert.deepEqual(facts.secretEnvNames, []);
    assert.equal(facts.dockerSocketMounted, false);
    assert.equal(facts.mounts.length, 1);
    assert.equal(facts.mounts[0].type, 'volume');
    assert.equal(facts.mounts[0].destination, '/workspace');

    codexHome = await createTemporaryCodexHome();
    client = await AppServerClient.start({
      accessToken: new SensitiveValue('synthetic-not-a-real-token-123456789', 'synthetic'),
      codexHome,
    });
    const info = await client.addEnvironment(baseline.execServerUrl, 'test-baseline');
    assert.equal(info.cwd, 'file:///workspace');
    assert.equal(info.shell.name, 'sh');

    await withHostCanaries(async (canaries) => {
      const clean = await collectSecurityProbe(baseline, canaries);
      assert.equal(securityProbePassed(clean), true);
      await dockerExec(baseline, ['sh', '-lc', 'mkdir -p /workspace/.codex && printf fake > /workspace/.codex/auth.json']);
      const exposedAuth = await collectSecurityProbe(baseline, canaries);
      assert.equal(securityProbePassed(exposedAuth), false);
      assert.ok(exposedAuth.realAuthMatches.includes('/workspace/.codex/auth.json'));
      await dockerExec(baseline, ['rm', '-rf', '/workspace/.codex']);
      await dockerExec(baseline, ['sh', '-lc', `printf fake > /workspace/${canaries.labName}`]);
      const exposedSentinel = await collectSecurityProbe(baseline, canaries);
      assert.equal(securityProbePassed(exposedSentinel), false);
      assert.ok(exposedSentinel.labSentinelMatches.some((match) => match.endsWith(canaries.labName)));
    });

    await dockerExec(baseline, ['sh', '-lc', "printf 'created in sandbox\\n' > /workspace/routing-created.txt && printf 'modified in sandbox\\n' > /workspace/routing-modify.txt && rm /workspace/routing-delete.txt && printf 'patched in sandbox\\n' > /workspace/routing-patch.txt"]);
    assert.deepEqual(await collectRoutingAssertions(baseline), {
      read: true, create: true, modify: true, delete: true, patch: true,
    });
    assert.equal((await collectWorkspaceSnapshot(treatment)).status, '');
  } finally {
    await client?.close();
    if (codexHome) await fs.rm(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const environment of environments.reverse()) await cleanupEnvironment(environment);
  }
});
