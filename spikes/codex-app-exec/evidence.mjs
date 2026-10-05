import { dockerExec } from './docker-environment.mjs';
import { sha256 } from './spike-support.mjs';

async function command(environment, argv, options = {}) {
  const result = await dockerExec(environment, argv, { timeoutMs: options.timeoutMs ?? 120_000 });
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function collectWorkspaceSnapshot(environment) {
  const [commit, tree, status, diff, diffStat] = await Promise.all([
    command(environment, ['git', '-C', '/workspace', 'rev-parse', 'HEAD']),
    command(environment, ['git', '-C', '/workspace', 'rev-parse', 'HEAD^{tree}']),
    command(environment, ['git', '-C', '/workspace', 'status', '--porcelain=v1', '--untracked-files=all']),
    command(environment, ['git', '-C', '/workspace', 'diff', '--binary']),
    command(environment, ['git', '-C', '/workspace', 'diff', '--stat']),
  ]);
  return {
    commit: commit.stdout.trim(),
    tree: tree.stdout.trim(),
    status: status.stdout,
    diff: diff.stdout,
    diffStat: diffStat.stdout,
  };
}

export async function runTargetTests(environment) {
  return command(environment, ['npm', 'test'], { timeoutMs: 120_000 });
}

export async function collectRoutingAssertions(environment) {
  const checks = {
    read: await command(environment, ['test', '-r', '/workspace/src/math.cjs']),
    create: await command(environment, ['grep', '-Fx', 'created in sandbox', '/workspace/routing-created.txt']),
    modify: await command(environment, ['grep', '-Fx', 'modified in sandbox', '/workspace/routing-modify.txt']),
    delete: await command(environment, ['test', '!', '-e', '/workspace/routing-delete.txt']),
    patch: await command(environment, ['grep', '-Fx', 'patched in sandbox', '/workspace/routing-patch.txt']),
  };
  return Object.fromEntries(Object.entries(checks).map(([name, result]) => [name, result.exitCode === 0]));
}

function itemSummary(item) {
  if (!item || typeof item !== 'object') return null;
  const changes = Array.isArray(item.changes)
    ? item.changes.map((change) => ({
      path: typeof change?.path === 'string' ? change.path : null,
      kind: typeof change?.kind === 'string' ? change.kind : change?.kind?.type ?? null,
    })).filter((change) => change.path)
    : undefined;
  return {
    id: item.id ?? null,
    type: item.type ?? null,
    status: item.status ?? null,
    command: typeof item.command === 'string' ? item.command : undefined,
    cwd: item.cwd ?? undefined,
    exitCode: item.exitCode ?? undefined,
    durationMs: item.durationMs ?? undefined,
    outputHash: typeof item.aggregatedOutput === 'string' ? sha256(item.aggregatedOutput) : undefined,
    changes,
  };
}

export function summarizeNotifications(events, attribution = {}) {
  return events
    .filter((event) => event.method !== 'item/agentMessage/delta')
    .map((event) => ({
    method: event.method,
    threadId: event.params?.threadId ?? null,
    turnId: event.params?.turnId ?? event.params?.turn?.id ?? null,
    environmentId: event.params?.environmentId
      ?? event.params?.item?.environmentId
      ?? (attribution.environmentId && event.params?.threadId === attribution.threadId
        ? attribution.environmentId
        : null),
    item: itemSummary(event.params?.item),
    }));
}

export function agentText(events) {
  return events
    .filter((event) => event.method === 'item/agentMessage/delta')
    .map((event) => event.params?.delta ?? '')
    .join('');
}

export function promptFingerprint(text) { return sha256(text); }
