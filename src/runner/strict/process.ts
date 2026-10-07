import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class ProcessExecutionError extends Error {
  readonly executable: string;
  readonly exitCode: number | null;
  readonly processSignal: NodeJS.Signals | null;

  constructor(executable: string, result: ProcessResult) {
    super(`${executable} failed with exit code ${result.code ?? "unknown"}`);
    this.name = "ProcessExecutionError";
    this.executable = executable;
    this.exitCode = result.code;
    this.processSignal = result.signal;
  }
}

export function createAbortError(): Error {
  const error = new Error("Strict runner operation aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

export function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const {
    cwd,
    env,
    input,
    signal,
    timeoutMs = 120_000,
    maxOutputBytes = 16 * 1024 * 1024,
  } = options;
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let terminalError: Error | undefined;
    let settled = false;

    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const abort = (): void => {
      terminalError = createAbortError();
      terminate();
    };
    const timeout = setTimeout(() => {
      terminalError = new Error(`${executable} timed out after ${timeoutMs} ms`);
      terminate();
    }, timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const failOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > maxOutputBytes) {
        terminalError = new Error(`${executable} exceeded the output limit`);
        terminate();
      }
      return next;
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", failOnce);
    child.once("close", (code, processSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError) reject(terminalError);
      else resolve({ code, signal: processSignal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function checkedProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const result = await runProcess(executable, args, options);
  if (result.code !== 0) throw new ProcessExecutionError(executable, result);
  return result;
}
