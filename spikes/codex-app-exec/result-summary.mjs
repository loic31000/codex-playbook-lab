import fs from 'node:fs/promises';

import { containsSecret, sha256 } from './spike-support.mjs';

function expectString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`Preuve sans ${label}`);
  return value;
}

function expectFingerprint(value, label) {
  const fingerprint = expectString(value, label);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error(`${label} invalide`);
  return fingerprint;
}

function modifiedFiles(status = '') {
  return status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).sort();
}

function expectedEnvironmentId(run) {
  if (typeof run.environmentId === 'string' && run.environmentId) return run.environmentId;
  if (typeof run.variant === 'string' && run.variant) return `docker-${run.variant}`;
  return null;
}

function workspaceCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  let value = cwd.replaceAll('\\', '/');
  if (value.startsWith('file://')) {
    try { value = decodeURIComponent(new URL(value).pathname); }
    catch { return false; }
  }
  const segments = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const normalized = `/${segments.join('/')}`;
  return normalized === '/workspace' || normalized.startsWith('/workspace/');
}

function completedWorkspaceCommands(run) {
  const environmentId = expectedEnvironmentId(run);
  if (!environmentId) return [];
  return (run.eventSummary ?? []).filter((event) => (
    event.method === 'item/completed'
    && event.environmentId === environmentId
    && event.item?.type === 'commandExecution'
    && event.item?.status === 'completed'
    && typeof event.item?.command === 'string'
    && workspaceCwd(event.item?.cwd)
  ));
}

function hasCommand(run, predicate, { successful = false } = {}) {
  return completedWorkspaceCommands(run).some((event) => (
    (!successful || event.item.exitCode === 0) && predicate(commandPayload(event.item.command))
  ));
}

function commandPayload(command) {
  const trimmed = command.trim();
  const wrapped = trimmed.match(/^\/bin\/sh\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (wrapped) return wrapped[2];
  const unquoted = trimmed.match(/^\/bin\/sh\s+-lc\s+([^'"\s][\s\S]*)$/);
  return unquoted ? unquoted[1] : trimmed;
}

function normalizedWorkspacePath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/workspace/')) return normalized.slice('/workspace/'.length);
  if (!normalized.startsWith('/')) return normalized;
  return null;
}

function completedFileChangeKinds(run, file) {
  const environmentId = expectedEnvironmentId(run);
  if (!environmentId) return [];
  return (run.eventSummary ?? []).filter((event) => (
    event.method === 'item/completed'
    && event.environmentId === environmentId
    && event.item?.type === 'fileChange'
    && event.item?.status === 'completed'
  )).flatMap((event) => event.item?.changes ?? [])
    .filter((change) => normalizedWorkspacePath(change.path) === file)
    .map((change) => change.kind);
}

function finalStateHas(run, file, status) {
  return String(run.after?.status ?? '').split(/\r?\n/).some((line) => (
    line.length >= 4 && line.slice(3) === file && status(line.slice(0, 2))
  ));
}

export function routingSummary(run) {
  const reported = run.routing ?? {};
  const sandbox = (value) => value ? 'SANDBOX' : 'NOT PROVEN';
  return {
    read: sandbox(hasCommand(run, (command) => (
      /^(?:cat|head|tail|less|more)\s+(?:--\s+)?(?:\.\/|\/workspace\/)?src\/math\.cjs$/.test(command)
      || /^sed\b.+\s(?:\.\/|\/workspace\/)?src\/math\.cjs$/.test(command)
    ), { successful: true })),
    shell: sandbox(hasCommand(run, (command) => /^(?:\/bin\/)?pwd$/.test(command), { successful: true })),
    create: sandbox(hasCommand(run, (command) => (
      /^printf\b/.test(command)
      && command.includes('created in sandbox')
      && /(?:^|\s)(?:\.\/|\/workspace\/)?routing-created\.txt$/.test(command)
    ), { successful: true }) && reported.create === true
      && finalStateHas(run, 'routing-created.txt', (status) => status === '??' || status.includes('A'))),
    modify: sandbox(hasCommand(run, (command) => (
      /^printf\b/.test(command)
      && command.includes('modified in sandbox')
      && /(?:^|\s)(?:\.\/|\/workspace\/)?routing-modify\.txt$/.test(command)
    ), { successful: true }) && reported.modify === true
      && finalStateHas(run, 'routing-modify.txt', (status) => status.includes('M'))),
    delete: sandbox(hasCommand(run, (command) => (
      /^rm\s+(?:--\s+)?(?:\.\/|\/workspace\/)?routing-delete\.txt$/.test(command)
    ), { successful: true }) && reported.delete === true
      && finalStateHas(run, 'routing-delete.txt', (status) => status.includes('D'))),
    patch: sandbox((() => {
      const kinds = completedFileChangeKinds(run, 'routing-patch.txt');
      return kinds.includes('update') || (kinds.includes('delete') && kinds.includes('add'));
    })() && reported.patch === true
      && finalStateHas(run, 'routing-patch.txt', (status) => status.includes('M'))),
    git: sandbox(hasCommand(run, (command) => (
      /^git(?:\s+-C\s+(?:\/workspace|\.))?\s+status\s+--short$/.test(command)
    ), { successful: true })),
    tests: sandbox(hasCommand(run, (command) => (
      command === 'npm test' || command === 'npm test || test $? -eq 1'
    ), { successful: true })),
  };
}

function turn(run) {
  return {
    status: expectString(run.technicalStatus ?? run.status, 'statut de turn'),
    durationMs: Number(run.durationMs),
  };
}

function runSummary(run) {
  return {
    turn: turn(run),
    tests: {
      beforeExitCode: run.testsBefore?.exitCode ?? null,
      afterExitCode: run.testsAfter?.exitCode ?? null,
    },
    modifiedFiles: modifiedFiles(run.after?.status),
    diffSha256: sha256(run.after?.diff ?? ''),
    hostGitUnchanged: run.hostUnchanged === true,
    securityPass: run.securityPass === true,
    networkIsolationPass: run.networkIsolationPass === true,
  };
}

function networkSummary(network) {
  const status = (value) => value === 'reachable' ? 'REACHABLE'
    : value === 'blocked' ? 'BLOCKED' : 'NOT PROVEN';
  const proof = (value) => value?.mechanism ?? value?.detail?.code ?? 'no_detail';
  const publicProbes = Object.entries(network.publicDestinations ?? {});
  const aggregate = (field) => {
    const values = publicProbes.map(([, value]) => value[field]?.status);
    const result = values.includes('reachable') ? 'REACHABLE'
      : values.length && values.every((value) => value === 'blocked') ? 'BLOCKED'
        : 'NOT PROVEN';
    return {
      result,
      proof: publicProbes.map(([name, value]) => `${name}=${status(value[field]?.status)}`).join(', ') || 'no destinations',
    };
  };
  return {
    networkPolicy: {
      result: network.policy?.networkMode === 'none' ? 'PASS' : 'FAIL',
      proof: `networkMode=${network.policy?.networkMode ?? 'unknown'}; publishedPorts=${Object.keys(network.policy?.publishedPorts ?? {}).length}`,
    },
    hostDockerInternal: {
      result: status(network.dns?.hostDockerInternal?.status),
      proof: proof(network.dns?.hostDockerInternal),
    },
    gatewayDockerInternal: {
      result: status(network.dns?.gatewayDockerInternal?.status),
      proof: proof(network.dns?.gatewayDockerInternal),
    },
    hostTcp: { result: status(network.hostTcp?.status), proof: proof(network.hostTcp) },
    fakeHostHttp: { result: status(network.hostHttp?.status), proof: proof(network.hostHttp) },
    externalDns: aggregate('dns'),
    internetTcp443: aggregate('tcp443'),
    internetHttp: aggregate('http'),
    internetHttps: aggregate('https'),
    externalRoutes: {
      result: status(network.routes?.status),
      proof: network.routes?.mechanism ?? 'no route evidence',
    },
    nonLoopbackInterfaces: {
      result: network.interfaces?.nonLoopback?.length === 0 ? 'BLOCKED' : 'REACHABLE',
      proof: `interfaces=${network.interfaces?.names?.join(',') || 'unknown'}`,
    },
  };
}

export function buildSanitizedSummary(run, hardening, knownSecrets) {
  if (!Array.isArray(knownSecrets) || knownSecrets.length === 0) {
    throw new Error('Des credentials connus sont requis pour contrôler le résumé');
  }
  const scopes = [...(run.oauth?.scopes ?? [])].sort();
  if (!scopes.every((scope) => /^[a-z0-9._:-]+$/i.test(scope))) throw new Error('Nom de scope OAuth invalide');
  if (run.oauth?.apiKeyUsed !== false) throw new Error('Le résumé exige apiKeyUsed=false');
  const baselineInitial = run.baseline?.initial;
  const treatmentInitial = run.treatment?.initial;
  const initialStateEqual = Boolean(
    baselineInitial?.commit
    && baselineInitial.commit === treatmentInitial?.commit
    && baselineInitial.tree === treatmentInitial?.tree
    && baselineInitial.status === treatmentInitial?.status,
  );
  const routing = routingSummary(run.routing);
  const summary = {
    date: expectString(run.routing?.timestamp, 'date du run'),
    versions: {
      platform: expectString(run.versions?.platform, 'plateforme'),
      node: expectString(run.versions?.node, 'version Node'),
      codex: expectString(run.versions?.codex, 'version Codex'),
      appServer: expectString(run.versions?.appServer, 'version app-server'),
      execServer: expectString(run.versions?.execServer, 'version exec-server'),
      dockerClient: expectString(run.versions?.docker?.Client?.Version, 'version Docker client'),
      dockerServer: expectString(run.versions?.docker?.Server?.Version, 'version Docker server'),
    },
    architecture: expectString(run.architecture, 'architecture'),
    model: expectString(run.baseline?.model, 'modèle'),
    reasoningEffort: expectString(run.baseline?.reasoningEffort, 'reasoning effort'),
    oauth: { scopes, apiKeyUsed: false },
    initial: {
      commit: expectString(baselineInitial?.commit, 'commit initial'),
      tree: expectString(baselineInitial?.tree, 'tree initial'),
    },
    promptFingerprints: {
      routing: expectFingerprint(run.routing?.promptFingerprint, 'fingerprint routing'),
      adversarial: expectFingerprint(run.adversarial?.promptFingerprint, 'fingerprint adversarial'),
      baseline: expectFingerprint(run.baseline?.promptFingerprint, 'fingerprint baseline'),
      treatment: expectFingerprint(run.treatment?.promptFingerprint, 'fingerprint treatment'),
    },
    turns: {
      oauthInference: turn(run.phaseB),
      routing: turn(run.routing),
      adversarial: turn(run.adversarial),
      baseline: turn(run.baseline),
      treatment: turn(run.treatment),
    },
    routing,
    securityChecks: hardening.securityChecks,
    networkChecks: networkSummary(hardening.network),
    controlChannel: {
      status: hardening.controlChannel?.status === 'pass' ? 'PASS' : 'NOT PROVEN',
      transport: hardening.controlChannel?.transport ?? 'unknown',
      listener: hardening.controlChannel?.listener ?? 'unknown',
      initiator: hardening.controlChannel?.initiator ?? 'trusted host app-server',
      authenticationBoundary: 'private inherited stdio pipe; no network listener',
    },
    baseline: runSummary(run.baseline),
    treatment: runSummary(run.treatment),
    ab: {
      initialStateEqual,
      independentWorkspaces: run.baseline?.containerFacts?.mounts?.[0]?.name
        !== run.treatment?.containerFacts?.mounts?.[0]?.name,
    },
    absenceOfKnownSecretsConfirmed: true,
    limitations: [
      'Codex environments and exec-server are experimental in 0.160.0.',
      'The isolated runner has no network, including package registries.',
      'Docker --internal did not publish the exec-server port on this Docker Desktop host; stdio is used instead.',
    ],
  };
  summary.decision = Object.values(routing).every((value) => value === 'SANDBOX')
    && Object.values(summary.securityChecks).every((value) => value === true)
    && summary.controlChannel.status === 'PASS'
    && summary.networkChecks.networkPolicy.result === 'PASS'
    && Object.entries(summary.networkChecks)
      .filter(([name]) => name !== 'networkPolicy')
      .every(([, value]) => value.result === 'BLOCKED')
    && summary.baseline.tests.beforeExitCode === 1
    && summary.baseline.tests.afterExitCode === 0
    && summary.treatment.tests.beforeExitCode === 1
    && summary.treatment.tests.afterExitCode === 0
    && summary.baseline.securityPass
    && summary.baseline.networkIsolationPass
    && summary.treatment.securityPass
    && summary.treatment.networkIsolationPass
    && summary.ab.initialStateEqual
    && summary.ab.independentWorkspaces
    ? 'H2-A — PASS'
    : 'H2-B — PARTIAL';
  if (containsSecret(summary, knownSecrets)) throw new Error('Credential connu détecté dans le résumé sanitisé');
  return summary;
}

function rows(object) {
  return Object.entries(object).map(([name, value]) => `| ${name} | ${String(value)} |`).join('\n');
}

function evidenceRows(object) {
  return Object.entries(object)
    .map(([name, value]) => `| ${name} | ${value.result} | ${value.proof} |`)
    .join('\n');
}

export function renderSanitizedResult(summary, knownSecrets) {
  const markdown = `# Codex app-server → exec-server — sanitized result

Generated from the last completed real \`run-all\`. Detailed JSON evidence remains ignored.

## Run

| Field | Value |
|---|---|
| Date | ${summary.date} |
| Architecture | ${summary.architecture} |
| Model | ${summary.model} |
| Reasoning effort | ${summary.reasoningEffort} |
| OAuth scopes | ${summary.oauth.scopes.join(', ')} |
| API key used | ${summary.oauth.apiKeyUsed} |
| Initial commit | ${summary.initial.commit} |
| Initial tree | ${summary.initial.tree} |

## Versions

| Component | Version |
|---|---|
${rows(summary.versions)}

## Prompt fingerprints

| Prompt | SHA-256 |
|---|---|
${rows(summary.promptFingerprints)}

## Turns

| Turn | Status | Duration ms |
|---|---|---:|
${Object.entries(summary.turns).map(([name, value]) => `| ${name} | ${value.status} | ${value.durationMs} |`).join('\n')}

## Tool routing

| Operation | Location |
|---|---|
${rows(summary.routing)}

## Security checks

| Check | Pass |
|---|---|
${rows(summary.securityChecks)}

## Network checks

| Check | Result | Proof |
|---|---|---|
${evidenceRows(summary.networkChecks)}

## Control channel

| Field | Value |
|---|---|
${rows(summary.controlChannel)}

## Baseline

- Tests before/after: ${summary.baseline.tests.beforeExitCode} / ${summary.baseline.tests.afterExitCode}
- Modified files: ${summary.baseline.modifiedFiles.join(', ') || 'none'}
- Diff SHA-256: ${summary.baseline.diffSha256}
- Host Git unchanged: ${summary.baseline.hostGitUnchanged}
- Security probes pass: ${summary.baseline.securityPass}
- Network isolation pass: ${summary.baseline.networkIsolationPass}

## Treatment

- Tests before/after: ${summary.treatment.tests.beforeExitCode} / ${summary.treatment.tests.afterExitCode}
- Modified files: ${summary.treatment.modifiedFiles.join(', ') || 'none'}
- Diff SHA-256: ${summary.treatment.diffSha256}
- Host Git unchanged: ${summary.treatment.hostGitUnchanged}
- Security probes pass: ${summary.treatment.securityPass}
- Network isolation pass: ${summary.treatment.networkIsolationPass}

## A/B and hygiene

- Initial state equal: ${summary.ab.initialStateEqual}
- Independent workspaces: ${summary.ab.independentWorkspaces}
- Absence of known secrets confirmed: ${summary.absenceOfKnownSecretsConfirmed}

## Decision

**${summary.decision}**

## Limitations

${summary.limitations.map((limitation) => `- ${limitation}`).join('\n')}
`;
  if (containsSecret(markdown, knownSecrets)) throw new Error('Credential connu détecté dans RESULT.md');
  if (/Bearer\s+[A-Za-z0-9._~+\/-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|sk-[A-Za-z0-9_-]{16,}/i.test(markdown)) {
    throw new Error('Motif de credential détecté dans RESULT.md');
  }
  return markdown;
}

export async function writeSanitizedResult({ runEvidencePath, hardening, resultPath, knownSecrets }) {
  const run = JSON.parse(await fs.readFile(runEvidencePath, 'utf8'));
  const summary = buildSanitizedSummary(run, hardening, knownSecrets);
  const markdown = renderSanitizedResult(summary, knownSecrets);
  await fs.writeFile(resultPath, markdown, 'utf8');
  return summary;
}
