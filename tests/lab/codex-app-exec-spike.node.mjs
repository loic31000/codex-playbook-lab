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
  environmentDefinition,
  provisionEnvironment,
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
  classifyProbeResult, collectNetworkProbe, networkIsolationPassed,
} from '../../spikes/codex-app-exec/network-probe.mjs';
import {
  buildSanitizedSummary, renderSanitizedResult, routingSummary,
} from '../../spikes/codex-app-exec/result-summary.mjs';
import {
  FIXTURE_ROOT,
  LAB_ROOT,
  SensitiveValue,
  assertPinnedCodexVersion,
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

test('version Codex du spike strictement épinglée', () => {
  assert.equal(assertPinnedCodexVersion('codex-cli 0.160.0\n'), 'codex-cli 0.160.0');
  assert.throws(() => assertPinnedCodexVersion('codex-cli 0.161.0'), /Revalidez le routage/);
  assert.throws(() => assertPinnedCodexVersion('codex-cli 0.160.1'), /Revalidez le routage/);
});

test('preuves app-server conservent les commandes objectives sans flux de texte volumineux', () => {
  const summary = summarizeNotifications([
    { method: 'item/agentMessage/delta', params: { delta: 'ignored' } },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          id: 'exec-1', type: 'commandExecution', status: 'completed',
          command: 'pwd', cwd: '/workspace', exitCode: 0, durationMs: 12,
          aggregatedOutput: '/workspace\n',
        },
      },
    },
  ], { threadId: 'thread-1', environmentId: 'docker-routing' });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].item.command, 'pwd');
  assert.equal(summary[0].item.cwd, '/workspace');
  assert.equal(summary[0].item.exitCode, 0);
  assert.equal(summary[0].environmentId, 'docker-routing');
  assert.match(summary[0].item.outputHash, /^[0-9a-f]{64}$/);
});

test('policy Docker stdio impose network none sans port publié', () => {
  const definition = environmentDefinition({
    container: 'codex-app-exec-spike-policy',
    volume: 'codex-app-exec-spike-policy-workspace',
    environmentId: 'docker-policy',
  });
  assert.equal(definition.program, 'docker');
  assert.deepEqual(definition.args.slice(0, 3), ['run', '--rm', '--interactive']);
  assert.equal(definition.args[definition.args.indexOf('--network') + 1], 'none');
  assert.equal(definition.args.includes('--publish'), false);
  assert.equal(definition.args.at(-1), 'stdio');
});

test('timeout réseau reste NOT PROVEN', () => {
  assert.deepEqual(classifyProbeResult({ timedOut: true }), {
    status: 'not_proven', detail: { code: 'timeout' },
  });
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
    labContentMatches: [], fakeOauthContentMatches: [], fakeAuthContentMatches: [], secretEnvNames: [],
  };
  assert.equal(securityProbePassed(clean), true);
  for (const mutation of [
    { secretEnvNames: ['ACCESS_TOKEN'] },
    { realAuthMatches: ['/workspace/.codex/auth.json'] },
    { labSentinelMatches: ['/workspace/LAB_SENTINEL_DO_NOT_EXPOSE'] },
    { fakeOauthMatches: ['/tmp/FAKE_OAUTH_TOKEN_DO_NOT_EXPOSE'] },
    { labContentMatches: ['/workspace/content.txt'] },
    { fakeOauthContentMatches: ['/workspace/content.txt'] },
    { fakeAuthContentMatches: ['/workspace/content.txt'] },
    { dockerSocketVisible: true },
    { targetReadable: false },
    { targetWritable: false },
  ]) {
    const report = { ...clean, ...mutation };
    assert.equal(securityProbePassed(report), false, JSON.stringify(mutation));
    assert.ok(Object.values(assessSecurityProbe(report)).includes(false));
  }
});

test('générateur RESULT.md allowliste les preuves et refuse un credential connu', () => {
  const secret = new SensitiveValue('synthetic-result-secret-1234567890', 'result-test');
  const baseRun = {
    timestamp: '2026-10-05T04:36:07.402Z',
    model: 'gpt-test', reasoningEffort: 'medium', promptFingerprint: 'a'.repeat(64),
    technicalStatus: 'completed', durationMs: 10,
    initial: { commit: 'commit', tree: 'tree', status: '' },
    after: { status: ' M src/math.cjs\n', diff: 'safe diff' },
    testsBefore: { exitCode: 1 }, testsAfter: { exitCode: 0 },
    containerFacts: { mounts: [{ name: 'volume-a' }] }, hostUnchanged: true,
  };
  const run = {
    architecture: 'trusted host -> stdio -> isolated Docker',
    oauth: { scopes: ['openid', 'resource.invoke'], apiKeyUsed: false },
    versions: {
      platform: 'Windows', node: 'v24', codex: 'codex-cli 0.160.0',
      appServer: 'codex-cli 0.160.0', execServer: 'codex-cli 0.160.0',
      docker: { Client: { Version: '29' }, Server: { Version: '29' } },
    },
    phaseB: { status: 'completed', durationMs: 5 },
    routing: {
      ...baseRun, routing: { read: true, create: true, modify: true, delete: true, patch: true },
      eventSummary: [{ item: { type: 'commandExecution', status: 'completed' } }],
      agentResponse: 'git status --short puis npm test',
    },
    adversarial: { ...baseRun, promptFingerprint: 'b'.repeat(64) },
    baseline: { ...baseRun, promptFingerprint: 'c'.repeat(64) },
    treatment: {
      ...baseRun,
      promptFingerprint: 'd'.repeat(64),
      containerFacts: { mounts: [{ name: 'volume-b' }] },
    },
  };
  const hardening = {
    securityChecks: { targetReadable: true, labContentInaccessible: true },
    network: {
      policy: { networkMode: 'none', publishedPorts: {} },
      dns: { hostDockerInternal: { status: 'blocked' }, gatewayDockerInternal: { status: 'blocked' } },
      hostTcp: { status: 'blocked' }, hostHttp: { status: 'blocked' },
      routes: { status: 'blocked', mechanism: 'no_routes' },
      interfaces: { names: ['lo'], nonLoopback: [] },
      publicDestinations: {
        'example.com': {
          dns: { status: 'blocked' }, tcp443: { status: 'blocked' },
          http: { status: 'blocked' }, https: { status: 'blocked' },
        },
        'www.iana.org': {
          dns: { status: 'blocked' }, tcp443: { status: 'blocked' },
          http: { status: 'blocked' }, https: { status: 'blocked' },
        },
      },
    },
    controlChannel: { status: 'pass', transport: 'stdio', listener: 'none' },
  };
  const summary = buildSanitizedSummary(run, hardening, [secret]);
  const markdown = renderSanitizedResult(summary, [secret]);
  assert.match(markdown, /Network checks/);
  assert.equal(markdown.includes(secret.reveal()), false);
  assert.throws(
    () => buildSanitizedSummary({ ...run, baseline: { ...run.baseline, model: secret.reveal() } }, hardening, [secret]),
    /Credential connu/,
  );
});

function routingEvent(command, { cwd = '/workspace', environmentId = 'docker-routing', exitCode = 0 } = {}) {
  return {
    method: 'item/completed',
    environmentId,
    item: { type: 'commandExecution', status: 'completed', command, cwd, exitCode },
  };
}

function fileChangeEvent(pathname, kind = 'update', environmentId = 'docker-routing') {
  return {
    method: 'item/completed',
    environmentId,
    item: {
      type: 'fileChange', status: 'completed', changes: [{ path: pathname, kind }],
    },
  };
}

function routingRun(eventSummary = [], overrides = {}) {
  return {
    variant: 'routing',
    environmentId: 'docker-routing',
    eventSummary,
    agentResponse: '',
    routing: { read: true, create: true, modify: true, delete: true, patch: true },
    after: {
      status: ' D routing-delete.txt\n M routing-modify.txt\n M routing-patch.txt\n?? routing-created.txt\n',
    },
    ...overrides,
  };
}

test('le texte agent ne prouve jamais les commandes git ou tests', () => {
  const routing = routingSummary(routingRun([], {
    agentResponse: "j'ai exécuté git status --short et npm test",
  }));
  assert.equal(routing.git, 'NOT PROVEN');
  assert.equal(routing.tests, 'NOT PROVEN');
  assert.equal(routing.create, 'NOT PROVEN');
  assert.equal(routing.modify, 'NOT PROVEN');
  assert.equal(routing.delete, 'NOT PROVEN');
  assert.equal(routing.patch, 'NOT PROVEN');
});

test('les événements objectifs prouvent pwd, lecture, git et tests dans le sandbox', () => {
  const routing = routingSummary(routingRun([
    routingEvent('/bin/sh -lc pwd'),
    routingEvent("/bin/sh -lc 'cat src/math.cjs'"),
    routingEvent("/bin/sh -lc 'git status --short'"),
    routingEvent("/bin/sh -lc 'npm test || test $? -eq 1'"),
  ]));
  assert.equal(routing.shell, 'SANDBOX');
  assert.equal(routing.read, 'SANDBOX');
  assert.equal(routing.git, 'SANDBOX');
  assert.equal(routing.tests, 'SANDBOX');
});

test('create, modify, delete et patch exigent événements et état final cohérents', () => {
  const routing = routingSummary(routingRun([
    routingEvent("printf 'created in sandbox\\n' > routing-created.txt"),
    routingEvent("printf 'modified in sandbox\\n' > routing-modify.txt"),
    routingEvent('rm routing-delete.txt'),
    fileChangeEvent('/workspace/routing-patch.txt', 'delete'),
    fileChangeEvent('/workspace/routing-patch.txt', 'add'),
  ]));
  assert.equal(routing.create, 'SANDBOX');
  assert.equal(routing.modify, 'SANDBOX');
  assert.equal(routing.delete, 'SANDBOX');
  assert.equal(routing.patch, 'SANDBOX');
  assert.equal(routingSummary(routingRun([
    routingEvent("printf 'created in sandbox\\n' > routing-created.txt"),
  ], { after: { status: '' } })).create, 'NOT PROVEN');
});

test('un cwd hors workspace ne prouve aucune commande distante', () => {
  const routing = routingSummary(routingRun([
    routingEvent('pwd', { cwd: 'C:/Users/example/repository' }),
    routingEvent('git status --short', { cwd: '/host/repository' }),
    routingEvent('npm test', { cwd: '/workspace/../host' }),
  ]));
  assert.equal(routing.shell, 'NOT PROVEN');
  assert.equal(routing.git, 'NOT PROVEN');
  assert.equal(routing.tests, 'NOT PROVEN');
});

test('un mauvais environmentId ou une lecture absente reste NOT PROVEN', () => {
  const wrongEnvironment = routingSummary(routingRun([
    routingEvent('git status --short', { environmentId: 'docker-other' }),
    routingEvent('npm test', { environmentId: 'docker-other' }),
    routingEvent('cat src/math.cjs', { environmentId: 'docker-other' }),
  ]));
  assert.equal(wrongEnvironment.git, 'NOT PROVEN');
  assert.equal(wrongEnvironment.tests, 'NOT PROVEN');
  assert.equal(wrongEnvironment.read, 'NOT PROVEN');
  assert.equal(routingSummary(routingRun()).read, 'NOT PROVEN');
  assert.equal(routingSummary(routingRun([
    routingEvent('cat src/math.cjs', { exitCode: 1 }),
  ])).read, 'NOT PROVEN');
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
    codexHome = await createTemporaryCodexHome();
    client = await AppServerClient.start({
      accessToken: new SensitiveValue('synthetic-not-a-real-token-123456789', 'synthetic'),
      codexHome,
      environments: [environmentDefinition(baseline), environmentDefinition(treatment)],
    });
    const [baselineInfo, treatmentInfo] = await Promise.all([
      provisionEnvironment(client, baseline), provisionEnvironment(client, treatment),
    ]);
    assert.equal(baselineInfo.cwd, 'file:///workspace');
    assert.equal(treatmentInfo.shell.name, 'sh');
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
    assert.equal(facts.controlTransport, 'stdio');
    assert.equal(facts.networkDisabled, true);
    assert.deepEqual(facts.publishedPorts, {});

    const network = await collectNetworkProbe(baseline);
    assert.equal(network.policy.networkMode, 'none');
    assert.equal(network.routes.status, 'blocked');
    assert.deepEqual(network.interfaces.nonLoopback, []);
    assert.equal(network.dns.hostDockerInternal.status, 'blocked');
    assert.equal(network.dns.gatewayDockerInternal.status, 'blocked');
    assert.equal(network.hostTcp.status, 'blocked');
    assert.equal(network.hostHttp.status, 'blocked');
    assert.equal(networkIsolationPassed(network), true);
    for (const probe of Object.values(network.publicDestinations)) {
      assert.equal(probe.dns.status, 'blocked');
      assert.equal(probe.tcp443.status, 'blocked');
      assert.equal(probe.http.status, 'blocked');
      assert.equal(probe.https.status, 'blocked');
    }

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
      await dockerExec(baseline, [
        'sh', '-lc',
        `printf '%s\n%s\n%s\n' '${canaries.labContent}' '${canaries.oauthContent}' '${canaries.authContent}' > /workspace/content-canaries.txt`,
      ]);
      const exposedContents = await collectSecurityProbe(baseline, canaries);
      assert.equal(securityProbePassed(exposedContents), false);
      assert.ok(exposedContents.labContentMatches.includes('/workspace/content-canaries.txt'));
      assert.ok(exposedContents.fakeOauthContentMatches.includes('/workspace/content-canaries.txt'));
      assert.ok(exposedContents.fakeAuthContentMatches.includes('/workspace/content-canaries.txt'));
      await dockerExec(baseline, ['rm', '-f', '/workspace/content-canaries.txt', `/workspace/${canaries.labName}`]);
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
  for (const environment of environments) {
    assert.notEqual((await runProcess('docker', ['inspect', environment.container])).code, 0);
    assert.notEqual((await runProcess('docker', ['volume', 'inspect', environment.volume])).code, 0);
  }
});
