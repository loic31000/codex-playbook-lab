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
    (!successful || event.item.exitCode === 0) && predicate(event.item.command.trim())
  ));
}

function hasCompletedFileChange(run) {
  const environmentId = expectedEnvironmentId(run);
  if (!environmentId) return false;
  return (run.eventSummary ?? []).some((event) => (
    event.method === 'item/completed'
    && event.environmentId === environmentId
    && event.item?.type === 'fileChange'
    && event.item?.status === 'completed'
  ));
}

function finalStateHas(run, file, status) {
  return String(run.after?.status ?? '').split(/\r?\n/).some((line) => (
    line.length >= 4 && line.slice(3) === file && status(line.slice(0, 2))
  ));
}

export function routingSummary(run) {
  const reported = run.routing ?? {};
  const sandbox = (value) => value ? 'SANDBOX' : 'NOT PROVEN';
  const fileChange = hasCompletedFileChange(run);
  return {
    read: sandbox(hasCommand(run, (command) => (
      /^(?:cat|head|tail|less|more)\s+(?:--\s+)?(?:\.\/|\/workspace\/)?src\/math\.cjs$/.test(command)
      || /^sed\b.+\s(?:\.\/|\/workspace\/)?src\/math\.cjs$/.test(command)
    ), { successful: true })),
    shell: sandbox(hasCommand(run, (command) => /^(?:\/bin\/)?pwd$/.test(command))),
    create: sandbox(fileChange && reported.create === true
      && finalStateHas(run, 'routing-created.txt', (status) => status === '??' || status.includes('A'))),
    modify: sandbox(fileChange && reported.modify === true
      && finalStateHas(run, 'routing-modify.txt', (status) => status.includes('M'))),
    delete: sandbox(fileChange && reported.delete === true
      && finalStateHas(run, 'routing-delete.txt', (status) => status.includes('D'))),
    patch: sandbox(fileChange && reported.patch === true
      && finalStateHas(run, 'routing-patch.txt', (status) => status.includes('M'))),
    git: sandbox(hasCommand(run, (command) => (
      /^git(?:\s+-C\s+(?:\/workspace|\.))?\s+status\s+--short$/.test(command)
    ))),
    tests: sandbox(hasCommand(run, (command) => /^npm\s+test$/.test(command))),
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
  };
}

function networkSummary(network) {
  return {
    hostDockerInternalResolution: network.dns?.hostDockerInternal?.status ?? 'not_proven',
    gatewayDockerInternalResolution: network.dns?.gatewayDockerInternal?.status ?? 'not_proven',
    hostHttp: network.hostHttp?.status ?? 'not_proven',
    internet: network.internet?.status ?? 'not_proven',
    dockerInternalNetwork: network.dockerNetwork?.internal === true,
    routesObserved: network.routes?.status === 'reachable',
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
    architecture: 'trusted Windows app-server -> authenticated loopback WebSocket -> Docker exec-server -> named-volume /workspace',
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
    routing: routingSummary(run.routing),
    securityChecks: hardening.securityChecks,
    networkChecks: networkSummary(hardening.network),
    websocketAuthentication: {
      mode: 'capability-token-sha256',
      unauthenticatedConnectionRejected: hardening.unauthenticatedWebSocketRejected === true,
    },
    baseline: runSummary(run.baseline),
    treatment: runSummary(run.treatment),
    ab: {
      initialStateEqual,
      independentWorkspaces: run.baseline?.containerFacts?.mounts?.[0]?.name
        !== run.treatment?.containerFacts?.mounts?.[0]?.name,
    },
    absenceOfKnownSecretsConfirmed: true,
  };
  if (containsSecret(summary, knownSecrets)) throw new Error('Credential connu détecté dans le résumé sanitisé');
  return summary;
}

function rows(object) {
  return Object.entries(object).map(([name, value]) => `| ${name} | ${String(value)} |`).join('\n');
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

| Check | Result |
|---|---|
${rows(summary.networkChecks)}

## WebSocket authentication

| Field | Value |
|---|---|
${rows(summary.websocketAuthentication)}

## Baseline

- Tests before/after: ${summary.baseline.tests.beforeExitCode} / ${summary.baseline.tests.afterExitCode}
- Modified files: ${summary.baseline.modifiedFiles.join(', ') || 'none'}
- Diff SHA-256: ${summary.baseline.diffSha256}
- Host Git unchanged: ${summary.baseline.hostGitUnchanged}

## Treatment

- Tests before/after: ${summary.treatment.tests.beforeExitCode} / ${summary.treatment.tests.afterExitCode}
- Modified files: ${summary.treatment.modifiedFiles.join(', ') || 'none'}
- Diff SHA-256: ${summary.treatment.diffSha256}
- Host Git unchanged: ${summary.treatment.hostGitUnchanged}

## A/B and hygiene

- Initial state equal: ${summary.ab.initialStateEqual}
- Independent workspaces: ${summary.ab.independentWorkspaces}
- Absence of known secrets confirmed: ${summary.absenceOfKnownSecretsConfirmed}
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
