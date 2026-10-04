import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as windows from '../platform/windows.mjs';
import * as posix from '../platform/posix.mjs';
import { colors, warn } from '../ui/console.mjs';

const platform = process.platform === 'win32' ? windows : posix;
const active = new Map();
let handlersInstalled = false;

export function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function usableFinal(content) { return typeof content === 'string' && content.trim().length > 0; }

export function evaluateExit({ code, signal, finalContent, allowUnknownFallback = false }) {
  if (Number.isInteger(code)) return { success: code === 0, exitStatus: code, fallback: false };
  const fallback = allowUnknownFallback && !signal && usableFinal(finalContent);
  return { success: fallback, exitStatus: 'unknown', fallback };
}

export function isRateLimitFailure(result) {
  if (result.success) return false;
  return /(HTTP\s*429|status code\s*429|rate_limit_exceeded|too many requests|insufficient_quota|credit_balance_exhausted|organization_(?:usage|spend)_limit_exceeded|project_spend_limit_exceeded|quota (?:exceeded|exhausted)|you(?:'|’)ve hit your usage limit|slow_down)/i.test(result.stderr ?? '');
}

export function isInfrastructureFailure(result) {
  if (result.success) return false;
  const text = `${result.spawnError ?? ''}\n${result.stderr ?? ''}`;
  return /(ENOENT|not recognized|command not found|unauthorized|authentication|not logged in|invalid api key|unknown (?:argument|option)|unexpected argument)/i.test(text);
}

export function resolveCodexCommand(command = process.env.CODEX_LAB_CODEX_COMMAND || 'codex', options = {}) {
  const platformName = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const hasPath = path.isAbsolute(command) || /[\\/]/.test(command);
  const extension = path.extname(command).toLowerCase();
  const direct = (resolved = command) => ({ file: resolved, argsPrefix: [], kind: 'direct', resolved });
  const commandShim = (resolved) => ({ file: env.ComSpec || env.COMSPEC || 'cmd.exe', argsPrefix: ['/d', '/s', '/c', resolved], kind: 'cmd-shim', resolved });
  if (platformName !== 'win32') return direct();
  if (hasPath) return ['.cmd', '.bat'].includes(extension) ? commandShim(command) : direct(command);

  const directories = String(env.PATH ?? '').split(';').filter(Boolean);
  for (const suffix of ['.exe', '.com', '.cmd', '.bat']) {
    for (const directory of directories) {
      const candidate = path.win32.join(directory.replace(/^"|"$/g, ''), `${command}${suffix}`);
      if (existsSync(candidate)) return ['.cmd', '.bat'].includes(suffix) ? commandShim(candidate) : direct(candidate);
    }
  }
  for (const directory of directories) {
    const base = directory.replace(/^"|"$/g, '');
    const extensionless = path.win32.join(base, command);
    if (existsSync(extensionless)) return direct(extensionless);
  }
  return direct(command);
}

export function codexSpawnSpec(command, args, options = {}) {
  const resolved = resolveCodexCommand(command, options);
  if (resolved.kind === 'cmd-shim') {
    const quote = (value) => {
      const text = String(value);
      if (/\r|\n/.test(text)) throw new Error('Argument Codex invalide : retour à la ligne interdit sous cmd.exe.');
      return `"${text.replace(/%/g, '%%').replace(/"/g, '""')}"`;
    };
    const commandLine = `"${[resolved.resolved, ...args].map(quote).join(' ')}"`;
    return { ...resolved, args: ['/d', '/s', '/c', commandLine], windowsVerbatimArguments: true };
  }
  return { ...resolved, args, windowsVerbatimArguments: false };
}

export function defaultCodexArgs(finalFile) {
  return ['exec', '--sandbox', 'workspace-write', '--ephemeral', '--color', 'never', '--output-last-message', finalFile, '-'];
}

export async function stopAllCodexChildren() {
  const outcomes = await Promise.all([...active.keys()].map(async (child) => ({ child, outcome: await platform.stopProcessTree(child.pid) })));
  for (const { child, outcome } of outcomes) {
    if (!outcome?.ok) warn(`Arrêt du processus ${child.pid} incomplet : ${outcome?.error || outcome?.stderr?.trim() || `code ${outcome?.code ?? 'unknown'}`}`);
  }
  return outcomes.map((x) => x.outcome);
}
export function activeCodexCount() { return active.size; }

export async function interruptActiveCodex(signal = 'SIGINT', { setExitCode = false } = {}) {
  for (const context of active.values()) context.interruptionSignal = signal;
  const outcomes = await stopAllCodexChildren();
  if (setExitCode) process.exitCode = signal === 'SIGINT' ? 130 : 143;
  return outcomes;
}

function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void interruptActiveCodex(signal, { setExitCode: true }); });
  }
}

async function collectProcess(child, input) {
  let stdout = ''; let stderr = ''; let spawnError = null; let stdinError = null;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', (error) => { stdinError = error; });
  child.stdin.end(input, 'utf8');
  const { code, signal } = await new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  const ignoredStdinError = stdinError?.code === 'EPIPE' && (code !== null || signal !== null);
  return { code, signal, stdout, stderr, spawnError, stdinError: ignoredStdinError ? null : stdinError };
}

export async function runCodexVersion({ command = process.env.CODEX_LAB_CODEX_COMMAND || 'codex', cwd = process.cwd() } = {}) {
  const spec = codexSpawnSpec(command, ['--version']);
  const child = spawn(spec.file, spec.args, { cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments });
  const result = await collectProcess(child, '');
  return { ...result, resolution: spec };
}

export async function runCodex({ input, outputDir, finalFile = path.join(outputDir, 'codex-final.txt'), activity = 'Codex travaille toujours...', command = process.env.CODEX_LAB_CODEX_COMMAND || 'codex', args, cwd = process.cwd(), heartbeatMs = 5000, allowUnknownFallback = false }) {
  installSignalHandlers();
  await mkdir(outputDir, { recursive: true });
  const stdoutFile = path.join(outputDir, 'codex-stdout.txt');
  const stderrFile = path.join(outputDir, 'codex-stderr.txt');
  const logFile = path.join(outputDir, 'codex-log.txt');
  await writeFile(path.join(outputDir, 'codex-input.txt'), input, 'utf8');
  const codexArgs = args ?? defaultCodexArgs(finalFile);
  const started = performance.now();
  const spec = codexSpawnSpec(command, codexArgs);
  const child = spawn(spec.file, spec.args, {
    cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...platform.childOptions,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  const context = { interruptionSignal: null };
  active.set(child, context);
  const timer = setInterval(() => {
    const elapsed = (performance.now() - started) / 1000;
    console.log(colors.yellow(`    ⏳ ${formatElapsed(elapsed)} — ${activity}`));
  }, heartbeatMs);
  timer.unref();

  const processResult = await collectProcess(child, input);
  const { code, signal, stdout, stderr, spawnError, stdinError } = processResult;
  clearInterval(timer); active.delete(child);
  let finalContent = '';
  try { finalContent = await readFile(finalFile, 'utf8'); } catch {}
  const status = evaluateExit({ code, signal, finalContent, allowUnknownFallback });
  const elapsedSeconds = (performance.now() - started) / 1000;
  const interrupted = Boolean(context.interruptionSignal);
  if (interrupted || stdinError) status.success = false;
  const result = { ...status, code, signal, interruptionSignal: context.interruptionSignal, interrupted,
    stdout, stderr, spawnError: spawnError?.message ?? null, stdinError: stdinError?.message ?? null,
    commandResolution: spec, finalContent, elapsedSeconds };
  await Promise.all([
    writeFile(stdoutFile, stdout, 'utf8'), writeFile(stderrFile, stderr, 'utf8'),
    writeFile(logFile, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- process diagnostics ---\n${spawnError?.message ?? ''}${stdinError ? `\nstdin: ${stdinError.message}` : ''}\n`, 'utf8'),
    writeFile(path.join(outputDir, 'codex-exit-code.txt'), `${status.exitStatus}\n`, 'utf8'),
    writeFile(path.join(outputDir, 'codex-status.json'), `${JSON.stringify({ code: status.exitStatus, signal,
      interruptionSignal: context.interruptionSignal, success: status.success, fallback: status.fallback,
      spawnError: result.spawnError, stdinError: result.stdinError, elapsedSeconds }, null, 2)}\n`, 'utf8'),
  ]);
  return result;
}
