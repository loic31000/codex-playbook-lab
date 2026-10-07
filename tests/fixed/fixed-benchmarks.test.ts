import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEvidence, createExperiment } from "../../src/domain/index.js";
import {
  FIXED_BENCHMARK_INPUT_SEPARATOR,
  buildFixedBenchmarkModelInput,
  discoverFixedBenchmarks,
  discoverPrompts,
  runFixedBenchmark,
  selectFixedBenchmarks,
  selectPrompts,
  type FixedBenchmarkAgentExecutor,
} from "../../src/fixed/index.js";
import {
  StrictRunner,
  buildStrictRunnerImage,
  captureSourceState,
  runProcess,
  sourceStatesEqual,
} from "../../src/runner/strict/index.js";

const labRoot = path.resolve(".");
const fixtureRoot = path.join(labRoot, "tests", "fixtures", "fixed");
const fixturePlaybook = path.join(fixtureRoot, "playbook");
const fixtureBenchmarks = path.join(fixtureRoot, "benchmarks");
const oracleSentinel = "ORACLE_METADATA_SENTINEL_ISSUE_25";
const dockerAvailable = spawnSync("docker", ["info"], { windowsHide: true, stdio: "ignore" }).status === 0;
const integration = dockerAvailable ? it : it.skip;
const integrationImage = `codex-playbook-strict-runner:fixed-${process.pid}`;

function promptMarkdown(title: string, content: string): string {
  return `---\ntitre: ${title}\nformat: prompt\n---\n\n# ${title}\n\n## Prompt prêt à copier\n\n\`\`\`text\n${content}\n\`\`\`\n`;
}

function benchmarkMarkdown(overrides: Partial<Record<"format" | "id" | "prompt" | "title" | "expectation", string>> = {}, body = "# Story\n\nFaire le changement demandé."): string {
  const fields = {
    format: "codex-lab-benchmark",
    id: "001-case",
    prompt: "09-01-implementer-story",
    title: "Cas fixe",
    expectation: "implementation",
    ...overrides,
  };
  return `---\nformat: ${fields.format}\nid: ${fields.id}\nprompt: ${fields.prompt}\ntitle: ${fields.title}\nexpectation: ${fields.expectation}\n---\n\n${body}\n`;
}

async function temporaryDirectory<T>(label: string, callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), label));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function writeMarkdown(root: string, relativePath: string, content: string): Promise<void> {
  const destination = path.join(root, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, "utf8");
}

describe("fixed prompt and benchmark discovery", () => {
  it("exige des répertoires explicitement fournis", async () => {
    await expect(discoverPrompts("")).rejects.toThrow(/playbookDir must be explicitly provided/);
    await expect(discoverFixedBenchmarks("", [])).rejects.toThrow(/benchmarksDir must be explicitly provided/);
  });

  it("découvre les prompts dans un ordre déterministe avec des versions stables", async () => {
    await temporaryDirectory("codex-fixed-prompts-", async (playbookDir) => {
      await writeMarkdown(playbookDir, "10-Zeta/02 - Second.md", promptMarkdown("Second", "PROMPT_SECOND"));
      await writeMarkdown(playbookDir, "02-Alpha/01 - Premier.md", promptMarkdown("Premier", "PROMPT_FIRST"));
      await writeMarkdown(playbookDir, "README.md", "# Documentation ordinaire\n");

      const first = await discoverPrompts(playbookDir);
      const second = await discoverPrompts(playbookDir);
      expect(first.map(({ definition }) => definition.id)).toEqual(["02-01-premier", "10-02-second"]);
      expect(second).toEqual(first);
      expect(first[0]?.version.content).toBe("PROMPT_FIRST");
      expect(first[0]?.version.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(first[0]?.version.id).toContain(first[0]!.version.fingerprint!.slice(0, 16));
      expect(selectPrompts(first, "02-01-premier")).toEqual([first[0]]);

      const previousVersion = first[0]!.version;
      await writeMarkdown(playbookDir, "02-Alpha/01 - Premier.md", promptMarkdown("Premier", "PROMPT_FIRST_CHANGED"));
      const changed = (await discoverPrompts(playbookDir))[0]!.version;
      expect(changed.content).toBe("PROMPT_FIRST_CHANGED");
      expect(changed.fingerprint).not.toBe(previousVersion.fingerprint);
      expect(changed.id).not.toBe(previousVersion.id);
    });
  });

  it("conserve la compatibilité déterministe avec les dix benchmarks historiques", async () => {
    const prompts = await discoverPrompts(fixturePlaybook);
    const first = await discoverFixedBenchmarks(path.join(labRoot, "benchmarks"), prompts);
    const second = await discoverFixedBenchmarks(path.join(labRoot, "benchmarks"), prompts);
    expect(first).toHaveLength(10);
    expect(second).toEqual(first);
    expect(first.map(({ testCase }) => testCase.id)).toEqual([
      "001-ajouter-tache",
      "002-priorite-ambiguite",
      "003-lister-taches",
      "004-renommer-contrat-mutation",
      "005-rechercher-contrat-absence",
      "006-titre-bornes-1-80",
      "007-recherche-absence-hors-perimetre",
      "008-api-publique-index",
      "009-validation-titre-partagee",
      "010-priorite-contrat-complet-multifichier",
    ]);
    expect(selectFixedBenchmarks(first, "09-01-implementer-story")).toEqual(first);
    expect(selectFixedBenchmarks(first, first[0]!.id)).toEqual([first[0]]);
  });

  it("sépare strictement metadata, FixedCase et model inputs", async () => {
    const prompts = await discoverPrompts(fixturePlaybook);
    const [benchmark] = await discoverFixedBenchmarks(fixtureBenchmarks, prompts);
    const prompt = prompts[0]!;
    expect(benchmark?.expectation).toBe("implementation");
    expect(benchmark?.testCase).toEqual({
      kind: "fixed",
      id: "001-sentinel",
      title: "Cas sentinelle",
      input: "# Cas sentinelle\n\nCrée uniquement le fichier demandé par la Story.",
    });
    const baseline = buildFixedBenchmarkModelInput({
      variant: "baseline",
      promptVersion: prompt.version,
      testCase: benchmark!.testCase,
    });
    const treatment = buildFixedBenchmarkModelInput({
      variant: "treatment",
      promptVersion: prompt.version,
      testCase: benchmark!.testCase,
    });
    expect(baseline).toBe(benchmark!.testCase.input);
    expect(treatment).toBe(`${prompt.version.content}${FIXED_BENCHMARK_INPUT_SEPARATOR}${benchmark!.testCase.input}`);
    for (const modelInput of [baseline, treatment]) {
      expect(modelInput).not.toContain("format: codex-lab-benchmark");
      expect(modelInput).not.toContain("expectation:");
      expect(modelInput).not.toContain(oracleSentinel);
      expect(modelInput).not.toContain(benchmark!.sourcePath);
      expect(modelInput).not.toContain(benchmark!.sourceFingerprint);
    }
  });

  it.each([
    ["001-no-frontmatter.md", "# Story", /Frontmatter benchmark mal formé/],
    [
      "001b-malformed-frontmatter.md",
      "---\nformat: codex-lab-benchmark\nligne invalide\n---\n\n# Story\n",
      /Frontmatter benchmark mal formé/,
    ],
    ["002-format.md", benchmarkMarkdown({ format: "other" }), /Format benchmark incorrect/],
    ["003-id.md", benchmarkMarkdown({ id: "" }), /ID benchmark manquant ou invalide/],
    ["004-prompt.md", benchmarkMarkdown({ prompt: "INVALID PROMPT" }), /Prompt benchmark manquant ou invalide/],
    ["005-title.md", benchmarkMarkdown({ title: "" }), /Titre benchmark manquant/],
    ["006-body.md", benchmarkMarkdown({}, "   "), /Body benchmark vide/],
    ["007-expectation.md", benchmarkMarkdown({ expectation: "winner" }), /Expectation benchmark inconnue/],
    ["008-missing-prompt.md", benchmarkMarkdown({ prompt: "01-01-absent" }), /Prompt benchmark introuvable/],
  ])("refuse explicitement le benchmark invalide %s", async (filename, markdown, expected) => {
    await temporaryDirectory("codex-fixed-invalid-", async (benchmarksDir) => {
      await writeMarkdown(benchmarksDir, filename, markdown);
      const prompts = await discoverPrompts(fixturePlaybook);
      await expect(discoverFixedBenchmarks(benchmarksDir, prompts)).rejects.toThrow(expected);
      await expect(discoverFixedBenchmarks(benchmarksDir, prompts)).rejects.toThrow(filename);
    });
  });

  it("refuse un id dupliqué pour le même prompt", async () => {
    await temporaryDirectory("codex-fixed-duplicate-", async (benchmarksDir) => {
      await writeMarkdown(benchmarksDir, "a.md", benchmarkMarkdown());
      await writeMarkdown(benchmarksDir, "b.md", benchmarkMarkdown({}, "# Autre body"));
      const prompts = await discoverPrompts(fixturePlaybook);
      await expect(discoverFixedBenchmarks(benchmarksDir, prompts)).rejects.toThrow(/Benchmark dupliqué.*b\.md/);
    });
  });
});

let targetRoot = "";
let initialSourceState: Awaited<ReturnType<typeof captureSourceState>>;

async function targetGit(...args: string[]): Promise<void> {
  const result = await runProcess("git", ["-C", targetRoot, ...args], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`test git command failed with ${result.code}`);
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fixed-target-"));
  await fs.writeFile(path.join(targetRoot, "tracked.txt"), "committed\n", "utf8");
  await targetGit("init", "--quiet");
  await targetGit("config", "user.name", "Fixed Benchmark Test");
  await targetGit("config", "user.email", "fixed-benchmark@example.invalid");
  await targetGit("add", "-A");
  await targetGit("-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "initial");
  await fs.writeFile(path.join(targetRoot, "tracked.txt"), "preexisting dirty change\n", "utf8");
  await fs.writeFile(path.join(targetRoot, "preexisting-untracked.txt"), "preexisting untracked\n", "utf8");
  initialSourceState = await captureSourceState(targetRoot);
  await buildStrictRunnerImage({ dockerDirectory: path.join(labRoot, "docker"), image: integrationImage });
}, 600_000);

afterAll(async () => {
  if (!dockerAvailable) return;
  await fs.rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await runProcess("docker", ["image", "rm", "--force", integrationImage], { timeoutMs: 120_000 });
});

describe.sequential("fixed benchmark A/B strict integration", () => {
  integration("exécute BASELINE et TREATMENT depuis le même snapshot sans exposer l'oracle", async () => {
    const [prompt] = await discoverPrompts(fixturePlaybook);
    const [benchmark] = await discoverFixedBenchmarks(fixtureBenchmarks, [prompt!]);
    const experiment = createExperiment({
      id: "experiment-fixed-issue-25",
      promptDefinition: prompt!.definition,
      promptVersion: prompt!.version,
      target: {
        id: "fixed-target",
        source: "git",
        revision: initialSourceState.workspace.gitHead ?? undefined,
      },
      testCases: [benchmark!.testCase],
      configuration: { repetitions: 1 },
      runs: [],
    });
    const requests: Array<{ variant: string; modelInput: string }> = [];
    const exposureChecks: Array<{ workspace: number | null; environment: number | null; benchmarksPath: number | null }> = [];
    const executor: FixedBenchmarkAgentExecutor = {
      async execute(request) {
        requests.push({ variant: request.variant, modelInput: request.modelInput });
        const workspace = await request.environment.exec([
          "sh", "-lc", `grep -R -F '${oracleSentinel}' /workspace >/dev/null 2>&1`,
        ]);
        const environment = await request.environment.exec([
          "sh", "-lc", `env | grep -F '${oracleSentinel}' >/dev/null 2>&1`,
        ]);
        const benchmarksPath = await request.environment.exec(["test", "-e", "/workspace/benchmarks"]);
        exposureChecks.push({ workspace: workspace.code, environment: environment.code, benchmarksPath: benchmarksPath.code });
        const output = request.variant === "baseline" ? "baseline-only.txt" : "treatment-only.txt";
        const mutation = await request.environment.exec(["sh", "-lc", `printf '%s' '${request.variant}' > /workspace/${output}`]);
        return {
          exitCode: mutation.code ?? 1,
          evidence: [createEvidence({
            type: "fake-executor-exit",
            recordedAt: new Date().toISOString(),
            source: "fixed-benchmark-test",
            data: { variant: request.variant, exitCode: mutation.code ?? -1 },
          })],
        };
      },
    };
    const strictRunner = new StrictRunner({
      trustedHostCodexVersionEvidence: "codex-cli 0.160.0",
      labRoot,
      image: integrationImage,
    });

    const result = await runFixedBenchmark({
      strictRunner,
      targetPath: targetRoot,
      experiment,
      benchmark: benchmark!,
      executor,
    });

    expect(requests).toEqual([
      { variant: "baseline", modelInput: benchmark!.testCase.input },
      {
        variant: "treatment",
        modelInput: `${prompt!.version.content}${FIXED_BENCHMARK_INPUT_SEPARATOR}${benchmark!.testCase.input}`,
      },
    ]);
    expect(exposureChecks).toEqual([
      { workspace: 1, environment: 1, benchmarksPath: 1 },
      { workspace: 1, environment: 1, benchmarksPath: 1 },
    ]);
    expect(result.baseline.workspace.initial.fingerprint).toBe(result.treatment.workspace.initial.fingerprint);
    expect(result.baseline.workspace.initial.gitHead).toBe(result.treatment.workspace.initial.gitHead);
    expect(result.baseline.workspace.initial.gitTree).toBe(result.treatment.workspace.initial.gitTree);
    expect(result.baseline.workspace.initial.gitStatus).toBe(result.treatment.workspace.initial.gitStatus);
    expect(result.baseline.workspace.initial.gitStatus).toContain("tracked.txt");
    expect(result.baseline.workspace.initial.gitStatus).toContain("preexisting-untracked.txt");
    expect(result.baseline.environment.image).toBe(result.treatment.environment.image);
    expect(result.baseline.environment.volume).not.toBe(result.treatment.environment.volume);
    const policyShape = (resultValue: typeof result.baseline) => ({
      ...resultValue.environment.policyFacts,
      container: undefined,
      volume: undefined,
      mounts: resultValue.environment.policyFacts.mounts.map(({ name: _name, ...mount }) => mount),
    });
    expect(policyShape(result.baseline)).toEqual(policyShape(result.treatment));
    expect(result.baseline.workspace.changedFiles).toEqual(["baseline-only.txt"]);
    expect(result.treatment.workspace.changedFiles).toEqual(["treatment-only.txt"]);
    expect(result.baseline.workspace.changedFiles).not.toContain("tracked.txt");
    expect(result.baseline.workspace.changedFiles).not.toContain("preexisting-untracked.txt");
    expect(result.experimentId).toBe(experiment.id);
    expect(result.testCaseId).toBe(benchmark!.testCase.id);
    expect(result.promptVersionId).toBe(prompt!.version.id);
    expect(result.target).toEqual(experiment.target);
    expect(result.baseline.variant).toBe("baseline");
    expect(result.treatment.variant).toBe("treatment");
    expect(result.baseline.run.humanReviewStatus).toBe("pending_review");
    expect(result.treatment.run.humanReviewStatus).toBe("pending_review");
    expect(result.baseline.run.technicalStatus).toBe("completed");
    expect(result.treatment.run.technicalStatus).toBe("completed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(oracleSentinel);
    expect(serialized).not.toContain("format: codex-lab-benchmark");
    expect(serialized).not.toContain("expectation");
    expect(serialized).not.toMatch(/winner|betterPrompt|worsePrompt|verdict/i);
    expect(sourceStatesEqual(initialSourceState, await captureSourceState(targetRoot))).toBe(true);
    for (const volume of [result.baseline.environment.volume, result.treatment.environment.volume]) {
      const inspection = await runProcess("docker", ["volume", "inspect", volume], { timeoutMs: 30_000 });
      expect(inspection.code).not.toBe(0);
    }
  }, 300_000);
});
