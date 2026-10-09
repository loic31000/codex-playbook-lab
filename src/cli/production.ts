import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  createLabApplication,
  type ApplicationEventSink,
  type DiagnosticCheck,
  type DiagnosticInput,
  type DiagnosticsPort,
  type LabApplication,
} from "../application/index.js";
import { openEvidenceStore } from "../evidence/index.js";
import { discoverFixedBenchmarks, discoverPrompts } from "../fixed/index.js";

interface ProcessOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(program: string, args: readonly string[], cwd: string): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const windowsShim = process.platform === "win32" && (program === "npm" || program === "codex");
    const child = windowsShim
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", program, ...args], { cwd, windowsHide: true })
      : spawn(program, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function processCheck(
  id: string,
  program: string,
  args: readonly string[],
  cwd: string,
  success: (output: ProcessOutput) => string,
): Promise<DiagnosticCheck> {
  try {
    const output = await run(program, args, cwd);
    return output.code === 0
      ? { id, status: "ok", message: success(output) }
      : { id, status: "failure", message: `${program} exited with code ${String(output.code)}` };
  } catch (error) {
    return { id, status: "failure", message: `${program} unavailable`, data: { error: error instanceof Error ? error.name : "UnknownError" } };
  }
}

export function createProductionDiagnostics(): DiagnosticsPort {
  return {
    async diagnose(input: DiagnosticInput) {
      const checks: DiagnosticCheck[] = [];
      const repository = await processCheck("git.repository", "git", ["rev-parse", "--is-inside-work-tree"], input.repoDir, () => "Git repository available");
      checks.push(repository);
      let rawStatus: ProcessOutput | undefined;
      const status = await processCheck("git.status", "git", ["status", "--porcelain", "--untracked-files=all"], input.repoDir, (output) => {
        rawStatus = output;
        return (
        output.stdout.trim() === "" ? "Working tree clean" : "Working tree has local changes"
        );
      });
      checks.push(status.status === "ok" && rawStatus?.stdout.trim() !== "" ? { ...status, status: "warning" } : status);
      checks.push({ id: "node.version", status: "ok", message: `Node ${process.version}` });
      checks.push(await processCheck("npm.version", "npm", ["--version"], input.repoDir, (output) => `npm ${output.stdout.trim()}`));
      let codexOutput: ProcessOutput | undefined;
      const codex = await processCheck("codex.version", "codex", ["--version"], input.repoDir, (output) => {
        codexOutput = output;
        return `Codex CLI ${output.stdout.trim()} (validated architecture baseline: 0.160.0)`;
      });
      checks.push(
        codex.status === "ok" && !codexOutput?.stdout.includes("0.160.0")
          ? { ...codex, status: "warning" }
          : codex,
      );
      try {
        const prompts = await discoverPrompts(input.playbookDir);
        checks.push({ id: "playbook.prompts", status: "ok", message: `${prompts.length} prompts discovered`, data: { count: prompts.length } });
        if (input.benchmarksDir) {
          const benchmarks = await discoverFixedBenchmarks(input.benchmarksDir, prompts);
          checks.push({ id: "benchmarks", status: "ok", message: `${benchmarks.length} benchmarks discovered`, data: { count: benchmarks.length } });
        }
      } catch (error) {
        checks.push({ id: "playbook.prompts", status: "failure", message: "Prompt or benchmark discovery failed", data: { error: error instanceof Error ? error.name : "UnknownError" } });
      }
      try {
        await fs.access(path.resolve(input.evidenceStoreDir), constants.R_OK | constants.W_OK);
        checks.push({ id: "evidence.store", status: "ok", message: "Evidence store accessible" });
      } catch (error) {
        checks.push({ id: "evidence.store", status: "failure", message: "Evidence store unavailable", data: { error: error instanceof Error ? error.name : "UnknownError" } });
      }
      if (input.includeDocker) {
        checks.push(await processCheck("docker.version", "docker", ["--version"], input.repoDir, (output) => output.stdout.trim()));
      }
      return { ok: checks.every(({ status: checkStatus }) => checkStatus !== "failure"), checks };
    },
  };
}

export function createProductionLabApplication(input: {
  readonly onEvent?: ApplicationEventSink;
} = {}): LabApplication {
  return createLabApplication({
    openEvidenceStore,
    diagnostics: createProductionDiagnostics(),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });
}
