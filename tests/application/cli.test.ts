import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ApplicationError, type LabApplication } from "../../src/application/index.js";
import { main, CLI_EXIT_CODES, type CliDependencies, type CliWriter } from "../../src/cli/index.js";
import { runCliBootstrap } from "../../src/cli/bootstrap.js";

const execFileAsync = promisify(execFile);

class BufferWriter implements CliWriter {
  value = "";
  write(chunk: string): void { this.value += chunk; }
}

function harness(application: Partial<LabApplication>, input: Partial<CliDependencies> = {}) {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const legacyCalls: readonly string[][] = [];
  const dependencies: CliDependencies = {
    application: application as LabApplication,
    stdout,
    stderr,
    defaults: {
      repoDir: "repo",
      playbookDir: "playbook",
      benchmarksDir: "benchmarks",
      evidenceStoreDir: "store",
    },
    legacyMain: async (argv) => {
      (legacyCalls as string[][]).push([...argv]);
      return 0;
    },
    ...input,
  };
  return { dependencies, stdout, stderr, legacyCalls };
}

describe("CLI V2 adapter", () => {
  it("route prompts list et list vers Application", async () => {
    const calls: unknown[] = [];
    const h = harness({
      async discoverPrompts(input) {
        calls.push(input);
        return [{ definition: { id: "p", name: "P" }, version: { id: "p@1", promptDefinitionId: "p", content: "x" }, sourcePath: "host", relativePath: "p.md", sourceFingerprint: "a".repeat(64) }];
      },
    });
    expect(await main(["prompts", "list", "--json"], h.dependencies)).toBe(0);
    expect(await main(["list"], h.dependencies)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(h.legacyCalls).toEqual([]);
  });

  it("route benchmarks, report, review et promotion vers les use cases exacts", async () => {
    const calls: string[] = [];
    const h = harness({
      async discoverBenchmarks() { calls.push("benchmarks"); return []; },
      async buildReport() { calls.push("report"); return { structured: {} as never, json: "{}\n", markdown: "# Report\n" }; },
      async reviewRun(input) { calls.push("review"); return { plannedRunId: input.plannedRunId, status: input.status, recordFingerprint: "f".repeat(64) } as never; },
      async promoteCase(input) { calls.push("promote"); return { audit: { fixedCaseId: input.fixedCaseId, recordFingerprint: "a".repeat(64) } } as never; },
    });
    expect(await main(["benchmarks", "list"], h.dependencies)).toBe(0);
    expect(await main(["experiment", "report", "--plan", "p", "--json"], h.dependencies)).toBe(0);
    expect(await main(["review", "set", "--plan", "p", "--run", "r", "--status", "rejected", "--reviewer", "human"], h.dependencies)).toBe(0);
    expect(await main(["promote", "--plan", "p", "--run", "r", "--id", "fixed-id", "--title", "Title", "--expectation", "implementation", "--by", "human"], h.dependencies)).toBe(0);
    expect(calls).toEqual(["benchmarks", "report", "review", "promote"]);
  });

  it.each([
    ["INVALID_ARGUMENT", 2],
    ["NOT_FOUND", 3],
    ["CONFLICT", 4],
    ["CAPABILITY_UNAVAILABLE", 5],
    ["INFRASTRUCTURE_FAILURE", 5],
    ["DATA_INTEGRITY_FAILURE", 5],
    ["CANCELLED", 130],
    ["INTERNAL_ERROR", 1],
  ] as const)("mappe %s sans parser le message", async (code, expected) => {
    const h = harness({ async diagnose() { throw new ApplicationError(code, "same message"); } });
    expect(await main(["diagnostics", "--json"], h.dependencies)).toBe(expected);
    expect(JSON.parse(h.stderr.value)).toEqual({ error: { code, category: expect.any(String), message: "same message" } });
    expect(h.stderr.value).not.toContain("stack");
    expect(CLI_EXIT_CODES[code]).toBe(expected);
  });

  it("transforme une erreur inconnue en INTERNAL_ERROR sans stack", async () => {
    const h = harness({ async diagnose() { throw new Error("native"); } });
    expect(await main(["diagnostics"], h.dependencies)).toBe(1);
    expect(h.stderr.value).toBe("INTERNAL_ERROR: unexpected CLI failure\n");
  });

  it("retourne 130 apres SIGINT en passant par cancelOperation", async () => {
    let handler: (() => void) | undefined;
    let resolve!: (value: { planId: string; status: "interrupted" }) => void;
    const completion = new Promise<{ planId: string; status: "interrupted" }>((done) => { resolve = done; });
    const calls: string[] = [];
    const h = harness({
      startExperiment() { return { id: "operation", completion } as never; },
      async cancelOperation(id) { calls.push(id); resolve({ planId: "plan", status: "interrupted" }); },
    }, {
      signals: {
        onSigint(callback) { handler = callback; return () => { handler = undefined; }; },
      },
    });
    const running = main(["experiment", "run", "--plan", "p", "--target", "target"], h.dependencies);
    await Promise.resolve();
    handler?.();
    expect(await running).toBe(130);
    expect(calls).toEqual(["operation"]);
  });

  it("conserve check/list migres et les dispatchs legacy explicites ou aliases", async () => {
    const h = harness({
      async diagnose() { return { ok: true, checks: [] }; },
      async discoverPrompts() { return []; },
    });
    expect(await main(["check"], h.dependencies)).toBe(0);
    expect(await main(["list"], h.dependencies)).toBe(0);
    expect(await main(["suite", "selector", "--yes"], h.dependencies)).toBe(0);
    expect(await main(["legacy", "test", "selector", "--yes"], h.dependencies)).toBe(0);
    expect(h.legacyCalls).toEqual([["suite", "selector", "--yes"], ["test", "selector", "--yes"]]);
  });

  it("n'utilise aucun provider fictif lorsque production signale capability unavailable", async () => {
    const h = harness({
      generateCases() { return Promise.reject(new ApplicationError("CAPABILITY_UNAVAILABLE", "generator unavailable")); },
      startExperiment() { throw new ApplicationError("CAPABILITY_UNAVAILABLE", "executor unavailable"); },
    });
    expect(await main(["cases", "generate", "--spec", "{}", "--json"], h.dependencies)).toBe(5);
    expect(await main(["experiment", "run", "--plan", "p", "--target", "target", "--json"], h.dependencies)).toBe(5);
    expect(h.stderr.value.trim().split("\n").map((line) => JSON.parse(line).error.code)).toEqual([
      "CAPABILITY_UNAVAILABLE", "CAPABILITY_UNAVAILABLE",
    ]);
    expect(h.legacyCalls).toEqual([]);
  });

  it("rend les erreurs run invalides/absentes et refuse artifact --text --json", async () => {
    const invalid = harness({ startExperiment() { throw new ApplicationError("INVALID_ARGUMENT", "invalid fingerprint"); } });
    expect(await main(["experiment", "run", "--plan", "abc", "--target", "target", "--json"], invalid.dependencies)).toBe(2);
    const missing = harness({ startExperiment() { throw new ApplicationError("NOT_FOUND", "missing plan"); } });
    expect(await main(["experiment", "run", "--plan", "a".repeat(64), "--target", "target", "--json"], missing.dependencies)).toBe(3);
    const artifact = harness({ async readArtifact() { throw new Error("must not be called"); } });
    expect(await main(["artifact", "show", "--ref", `blobs/sha256/${"a".repeat(64)}`, "--text", "--json"], artifact.dependencies)).toBe(2);
    expect(JSON.parse(artifact.stderr.value).error.code).toBe("INVALID_ARGUMENT");
    expect(artifact.stdout.value).toBe("");
  });

  it("rend une erreur bootstrap EACCES en JSON infrastructure", async () => {
    const stdout = new BufferWriter();
    const stderr = new BufferWriter();
    const code = await runCliBootstrap(["diagnostics", "--json"], {
      stdout,
      stderr,
      loadRuntime: async () => ({
        applicationMain: async () => 0,
        createApplication: () => ({} as LabApplication),
      }),
      loadDefaults: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    });
    expect(code).toBe(5);
    expect(stdout.value).toBe("");
    expect(stderr.value.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stderr.value)).toEqual({
      error: {
        code: "INFRASTRUCTURE_FAILURE",
        category: "infrastructure",
        message: "CLI configuration or runtime is unavailable",
      },
    });
  });

  it("fait passer la config JSON invalide du vrai shim par le renderer type", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-bootstrap-"));
    const configPath = path.join(root, "invalid.json");
    await fs.writeFile(configPath, "{ invalid", "utf8");
    try {
      await expect(execFileAsync(process.execPath, [
        path.resolve("src/cli.mjs"), "diagnostics", "--json", "--config", configPath,
      ], { cwd: path.resolve(".") })).rejects.toMatchObject({
        code: 2,
        stdout: "",
        stderr: expect.stringMatching(/^\{"error":\{"code":"INVALID_ARGUMENT","category":"usage","message":"CLI configuration is invalid"\}\}\r?\n$/),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
