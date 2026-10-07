import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEvidence, type Experiment, type JsonObject } from "../../src/domain/index.js";
import {
  LocalRunExecutionError,
  canonicalJson,
  createExperimentExecutionPlan,
  sha256Exact,
  type BackendRunRequest,
  type ExecutionBaseline,
  type ExperimentAgentExecutor,
  type ExperimentExecutionBackend,
  type ExperimentExecutionSession,
  type ExperimentExecutionPlan,
} from "../../src/experiment/index.js";
import {
  EVIDENCE_STORE_FORMAT,
  EVIDENCE_STORE_VERSION,
  caseEvidenceFingerprint,
  configurationEvidenceFingerprint,
  openEvidenceStore,
  promptEvidenceFingerprint,
  runStoredExperimentPlan,
  runnerEvidenceFingerprint,
  targetEvidenceFingerprint,
  type FilesystemEvidenceStore,
} from "../../src/evidence/index.js";

const temporaryRoots: string[] = [];
const target = { id: "evidence-target", source: "git", revision: "abc123" } as const;
const generatedInput = "# Exact generated case\r\n\r\nPreserve bytes.  \r\n";
const promptContent = "Apply the evidence prompt exactly.";

function generationProvenance() {
  const instruction = "Generate one evidence-storage case.";
  return {
    generatorId: "generator-26",
    generatorVersion: "2.0.0",
    generatedAt: "2026-10-07T12:00:00.000Z",
    instruction: { kind: "content" as const, value: instruction },
    instructionVersion: "v1",
    instructionFingerprint: sha256Exact(instruction),
    model: "generator-model",
    modelOptions: { temperature: 0.25, nested: { mode: "strict" } },
    target,
    contentFingerprint: sha256Exact(generatedInput),
    reproducibility: "not_guaranteed" as const,
    seed: "seed-26-exact",
    parentRef: "generation-parent",
  };
}

function evidencePlan(id = "evidence-plan"): ExperimentExecutionPlan {
  return createExperimentExecutionPlan({
    id,
    experiments: [{
      id: "evidence-experiment",
      promptDefinition: { id: "evidence-prompt", name: "Evidence prompt" },
      promptVersion: {
        id: "evidence-prompt@v1",
        promptDefinitionId: "evidence-prompt",
        content: promptContent,
      },
      target,
      testCases: [{
        kind: "generated",
        id: "generated-evidence-case",
        title: "Generated evidence case",
        input: generatedInput,
        provenance: generationProvenance(),
      }],
      configuration: { repetitions: 1, timeoutMs: 45_000 },
      runs: [],
    }],
  });
}

function executionBaseline(overrides: Partial<ExecutionBaseline> = {}): ExecutionBaseline {
  return {
    target,
    workspaceFingerprint: "workspace-initial",
    gitHead: "abc123",
    gitTree: "tree123",
    gitStatus: "",
    image: "strict-image:0.160.0",
    policyFingerprint: "strict-policy-fingerprint",
    ...overrides,
  };
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++));
}

function richExecutor(modelOptions: JsonObject = {
  temperature: 0.7,
  topP: 0.9,
  nested: { effort: "high", mode: "strict" },
}): ExperimentAgentExecutor {
  return {
    async execute({ plannedRun, modelInput }) {
      return {
        exitCode: 0,
        evidence: [createEvidence({
          type: "test-command",
          recordedAt: "2026-10-07T12:30:00.000Z",
          source: "fake-agent",
          data: { command: "npm test", exitCode: 0 },
        })],
        transcript: {
          model: "fake-agent-model",
          modelOptions,
          finalOutput: `final:${plannedRun.variant}:${modelInput}`,
          stdout: `stdout:${plannedRun.ordinal}\n`,
          stderr: `stderr:${plannedRun.ordinal}\n`,
        },
      };
    },
  };
}

class EvidenceFakeBackend implements ExperimentExecutionBackend {
  readonly baseline: ExecutionBaseline;
  readonly crashOnCall: number | null;
  calls = 0;
  openCount = 0;
  closeCount = 0;

  constructor(input: { baseline?: ExecutionBaseline; crashOnCall?: number } = {}) {
    this.baseline = input.baseline ?? executionBaseline();
    this.crashOnCall = input.crashOnCall ?? null;
  }

  async open(input: Parameters<ExperimentExecutionBackend["open"]>[0]): Promise<ExperimentExecutionSession> {
    this.openCount += 1;
    if (input.expectedBaseline && canonicalJson(input.expectedBaseline) !== canonicalJson(this.baseline)) {
      throw new Error("fake baseline mismatch");
    }
    return {
      baseline: this.baseline,
      executeRun: async (request: BackendRunRequest) => {
        this.calls += 1;
        if (this.crashOnCall === this.calls) throw new Error("simulated process crash");
        let execution;
        try {
          execution = await request.executor.execute({
            plannedRun: request.plannedRun,
            experiment: request.experiment,
            testCase: request.testCase,
            promptVersion: request.experiment.promptVersion,
            variant: request.plannedRun.variant,
            repetition: request.plannedRun.repetition,
            environment: {
              id: `ephemeral-environment-${request.plannedRun.ordinal}`,
              volume: `ephemeral-volume-${request.plannedRun.ordinal}`,
              image: this.baseline.image,
              async exec() {
                return { code: 0, signal: null, stdout: "", stderr: "" };
              },
            },
            modelInput: request.modelInput,
            signal: request.signal,
          });
        } catch (error) {
          throw new LocalRunExecutionError(error);
        }
        const changedFile = `src/run-${request.plannedRun.ordinal}.txt`;
        return {
          exitCode: execution.exitCode,
          durationMs: 17,
          changedFiles: [changedFile],
          evidence: execution.evidence ?? [],
          transcript: execution.transcript,
          facts: {
            environmentId: `ephemeral-environment-${request.plannedRun.ordinal}`,
            volume: `ephemeral-volume-${request.plannedRun.ordinal}`,
            image: this.baseline.image,
            initialWorkspaceFingerprint: this.baseline.workspaceFingerprint,
            initialGitHead: this.baseline.gitHead,
            initialGitTree: this.baseline.gitTree,
            initialGitStatus: this.baseline.gitStatus,
            policyFingerprint: this.baseline.policyFingerprint,
            finalWorkspaceFingerprint: `workspace-final-${request.plannedRun.ordinal}`,
          },
          workspace: {
            initialWorkspaceFingerprint: this.baseline.workspaceFingerprint,
            finalWorkspaceFingerprint: `workspace-final-${request.plannedRun.ordinal}`,
            changes: [{
              path: changedFile,
              status: "added" as const,
              before: null,
              after: { kind: "file" as const, sha256: sha256Exact(`run-${request.plannedRun.ordinal}`) },
            }],
            changedFiles: [changedFile],
            initialGitDiffFromHead: "",
            finalGitDiffFromHead: [
              `diff --git a/${changedFile} b/${changedFile}`,
              "new file mode 100644",
              "--- /dev/null",
              `+++ b/${changedFile}`,
              "+evidence",
              "",
            ].join("\n"),
          },
        };
      },
      close: async () => {
        this.closeCount += 1;
      },
    };
  }
}

async function temporaryStore(): Promise<{ store: FilesystemEvidenceStore; storeRoot: string; targetPath: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codex-evidence-test-"));
  temporaryRoots.push(parent);
  const storeRoot = path.join(parent, "explicit-evidence-store");
  const targetPath = path.join(parent, "IDENTIFIABLE-ABSOLUTE-TARGET");
  await fs.mkdir(targetPath, { recursive: true });
  return { store: await openEvidenceStore(storeRoot), storeRoot, targetPath };
}

async function filesRecursively(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(absolute);
    }
  }
  await visit(root);
  return output.sort();
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )));
});

describe("filesystem evidence storage", () => {
  it("stores a complete factual run with exact portable artifacts and fingerprints", async () => {
    const { store, storeRoot, targetPath } = await temporaryStore();
    const plan = evidencePlan();
    const backend = new EvidenceFakeBackend();
    const state = await runStoredExperimentPlan({
      store,
      plan,
      backend,
      targetPath,
      executor: richExecutor(),
      now: deterministicClock(),
    });

    expect(state.status).toBe("completed");
    expect(state.runs).toHaveLength(2);
    expect(await fs.readFile(path.join(storeRoot, "format.json"), "utf8")).toContain(EVIDENCE_STORE_FORMAT);
    expect(await fs.readFile(path.join(storeRoot, "plans", plan.fingerprint, "plan.json"), "utf8"))
      .toContain(generationProvenance().contentFingerprint);
    const latest = await store.readLatestCheckpoint(plan.fingerprint);
    expect(latest.invalidCheckpointRefs).toEqual([]);
    expect(latest.checkpoint?.state.status).toBe("completed");
    const checkpointFiles = (await fs.readdir(path.join(storeRoot, "plans", plan.fingerprint, "checkpoints")))
      .filter((entry) => /^\d{8}\.json$/.test(entry));
    expect(checkpointFiles.length).toBeGreaterThanOrEqual(6);
    expect(checkpointFiles).toEqual([...checkpointFiles].sort());
    expect(await store.readPlan(plan.fingerprint)).toEqual(plan);

    for (const plannedRun of plan.plannedRuns) {
      const attempts = await store.listRunAttempts(plan.fingerprint, plannedRun.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe("finalized");
      const stored = await store.readAttempt(plan.fingerprint, plannedRun.id, 1);
      expect(stored.started).toMatchObject({
        format: EVIDENCE_STORE_FORMAT,
        version: EVIDENCE_STORE_VERSION,
        kind: "attempt-started",
        plannedRunId: plannedRun.id,
        attempt: 1,
        baseline: executionBaseline(),
      });
      const manifest = stored.manifest!;
      expect(manifest).toMatchObject({
        kind: "attempt-manifest",
        plannedRunId: plannedRun.id,
        attempt: 1,
        technicalStatus: "completed",
        humanReviewStatus: "pending_review",
        durationMs: 17,
        exitCode: 0,
        changedFiles: [`src/run-${plannedRun.ordinal}.txt`],
        agent: { model: "fake-agent-model" },
      });
      expect(manifest.experimentRun.evidence).toHaveLength(1);
      expect(manifest.workspace.initialGitDiffAvailable).toBe(true);
      expect(manifest.workspace.finalGitDiffAvailable).toBe(true);
      expect(manifest.workspace).not.toHaveProperty("initialGitDiffFromHead");
      expect(manifest.workspace).not.toHaveProperty("finalGitDiffFromHead");
      expect(manifest.testCase).toEqual(plan.experiments[0]!.testCases[0]);
      const expectedInput = plannedRun.variant === "baseline"
        ? generatedInput
        : `${promptContent}\n\n---\n\n${generatedInput}`;
      expect((await store.readArtifact(manifest.artifacts.modelInput)).toString("utf8")).toBe(expectedInput);
      expect((await store.readArtifact(manifest.artifacts.finalOutput)).toString("utf8"))
        .toBe(`final:${plannedRun.variant}:${expectedInput}`);
      expect((await store.readArtifact(manifest.artifacts.stdout)).toString("utf8"))
        .toBe(`stdout:${plannedRun.ordinal}\n`);
      expect((await store.readArtifact(manifest.artifacts.stderr)).toString("utf8"))
        .toBe(`stderr:${plannedRun.ordinal}\n`);
      expect((await store.readArtifact(manifest.artifacts.initialGitDiffFromHead!)).toString("utf8")).toBe("");
      const finalDiff = (await store.readArtifact(manifest.artifacts.finalGitDiffFromHead!)).toString("utf8");
      expect(finalDiff).toContain(`diff --git a/src/run-${plannedRun.ordinal}.txt b/src/run-${plannedRun.ordinal}.txt`);
      expect(finalDiff).not.toContain(targetPath);
      expect(manifest.fingerprints).toEqual({
        prompt: promptEvidenceFingerprint(plan.experiments[0]!.promptVersion),
        testCase: caseEvidenceFingerprint(plan.experiments[0]!.testCases[0]!),
        target: targetEvidenceFingerprint(plan.target, executionBaseline()),
        runner: runnerEvidenceFingerprint(executionBaseline()),
        configuration: configurationEvidenceFingerprint({
          model: "fake-agent-model",
          modelOptions: manifest.agent.modelOptions,
          experiment: plan.experiments[0]!,
        }),
        plan: plan.fingerprint,
      });
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toMatch(/winner|betterPrompt|worsePrompt|verdict|score|correct|promotion/i);
      expect(serialized).not.toContain("ephemeral-volume");
      expect(serialized).not.toContain("ephemeral-environment");
    }

    const allContent = (await Promise.all((await filesRecursively(storeRoot)).map((filename) => fs.readFile(filename))))
      .map((value) => value.toString("utf8"))
      .join("\n");
    expect(allContent).not.toContain(targetPath);
    expect(allContent).not.toContain(storeRoot);
    expect(allContent).not.toContain(path.resolve("."));
  });

  it("keeps a crashed attempt partial and resumes it as immutable attempt 2 in a new process", async () => {
    const { store, storeRoot, targetPath } = await temporaryStore();
    const plan = evidencePlan("crash-resume-plan");
    await expect(runStoredExperimentPlan({
      store,
      plan,
      backend: new EvidenceFakeBackend({ crashOnCall: 1 }),
      targetPath,
      executor: richExecutor(),
      now: deterministicClock(),
    })).rejects.toThrow(/simulated process crash/);

    const firstRun = plan.plannedRuns[0]!;
    const partialAttempts = await store.listRunAttempts(plan.fingerprint, firstRun.id);
    expect(partialAttempts).toEqual([expect.objectContaining({ attempt: 1, status: "partial", manifestRef: null })]);
    const latestAfterCrash = await store.readLatestCheckpoint(plan.fingerprint);
    expect(latestAfterCrash.checkpoint?.state.runs[0]).toMatchObject({
      attempt: 1,
      run: { technicalStatus: "running" },
    });

    const reopened = await openEvidenceStore(storeRoot);
    const resumed = await runStoredExperimentPlan({
      store: reopened,
      plan,
      backend: new EvidenceFakeBackend(),
      targetPath,
      executor: richExecutor(),
      resume: true,
      now: deterministicClock(),
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.runs).toHaveLength(2);
    expect(new Set(resumed.runs.map(({ plannedRunId }) => plannedRunId)).size).toBe(2);
    expect(resumed.runs[0]!.attempt).toBe(2);
    expect(await reopened.listRunAttempts(plan.fingerprint, firstRun.id)).toEqual([
      expect.objectContaining({ attempt: 1, status: "partial" }),
      expect.objectContaining({ attempt: 2, status: "finalized" }),
    ]);
    expect((await reopened.readAttempt(plan.fingerprint, firstRun.id, 1)).manifest).toBeNull();
    expect((await reopened.readAttempt(plan.fingerprint, firstRun.id, 2)).manifest?.technicalStatus).toBe("completed");
  });

  it("falls back to the newest valid checkpoint when a newer file is truncated", async () => {
    const { store, storeRoot, targetPath } = await temporaryStore();
    const plan = evidencePlan("corrupt-checkpoint-plan");
    await runStoredExperimentPlan({
      store,
      plan,
      backend: new EvidenceFakeBackend(),
      targetPath,
      executor: richExecutor(),
      now: deterministicClock(),
    });
    const before = await store.readLatestCheckpoint(plan.fingerprint);
    const corruptRef = `plans/${plan.fingerprint}/checkpoints/99999999.json`;
    await fs.writeFile(path.join(storeRoot, ...corruptRef.split("/")), '{"format":', "utf8");
    const after = await store.readLatestCheckpoint(plan.fingerprint);
    expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.invalidCheckpointRefs).toEqual([corruptRef]);
  });

  it("makes blobs, plans and finalized manifests write-once with exact idempotence", async () => {
    const { store, storeRoot, targetPath } = await temporaryStore();
    const blob = await store.putArtifact("immutable", "text/plain");
    expect(await store.putArtifact("immutable", "text/plain")).toEqual(blob);
    await fs.writeFile(path.join(storeRoot, ...blob.ref.split("/")), "collision", "utf8");
    await expect(store.putArtifact("immutable", "text/plain")).rejects.toThrow(/different content/);

    const isolated = await temporaryStore();
    const plan = evidencePlan("immutable-plan");
    await isolated.store.writePlan(plan, [isolated.targetPath]);
    await isolated.store.writePlan(plan, [isolated.targetPath]);
    const forged = JSON.parse(JSON.stringify(plan)) as ExperimentExecutionPlan;
    (forged as unknown as Record<string, unknown>).id = "forged-plan-id";
    await expect(isolated.store.writePlan(forged, [isolated.targetPath])).rejects.toThrow(/canonical fingerprint/);

    await runStoredExperimentPlan({
      store: isolated.store,
      plan,
      backend: new EvidenceFakeBackend(),
      targetPath: isolated.targetPath,
      executor: richExecutor(),
      now: deterministicClock(),
    });
    const attempt = await isolated.store.readAttempt(plan.fingerprint, plan.plannedRuns[0]!.id, 1);
    await isolated.store.finalizeAttempt(attempt.manifest!, [isolated.targetPath]);
    await expect(isolated.store.finalizeAttempt({
      ...attempt.manifest!,
      durationMs: attempt.manifest!.durationMs + 1,
    }, [isolated.targetPath])).rejects.toThrow(/different content/);
  });

  it("fingerprints exact prompt, target, runner and canonical semantic configuration", () => {
    const plan = evidencePlan("fingerprint-plan");
    const experiment = plan.experiments[0]!;
    const changedPromptRaw = JSON.parse(JSON.stringify(experiment)) as Experiment;
    (changedPromptRaw.promptVersion as unknown as Record<string, unknown>).content = `${promptContent}!`;
    const changedPlan = createExperimentExecutionPlan({ id: plan.id, experiments: [changedPromptRaw] });
    expect(promptEvidenceFingerprint(changedPlan.experiments[0]!.promptVersion))
      .not.toBe(promptEvidenceFingerprint(experiment.promptVersion));
    expect(changedPlan.fingerprint).not.toBe(plan.fingerprint);

    expect(targetEvidenceFingerprint(target, executionBaseline({ gitStatus: "" })))
      .not.toBe(targetEvidenceFingerprint(target, executionBaseline({ gitStatus: " M src/file.ts\0" })));
    expect(runnerEvidenceFingerprint(executionBaseline({ image: "image:a" })))
      .not.toBe(runnerEvidenceFingerprint(executionBaseline({ image: "image:b" })));

    const firstOptions = {
      temperature: 0.7,
      topP: 0.9,
      nested: { effort: "high", mode: "strict" },
    };
    const reorderedOptions = {
      nested: { mode: "strict", effort: "high" },
      topP: 0.9,
      temperature: 0.7,
    };
    const first = configurationEvidenceFingerprint({ model: "model", modelOptions: firstOptions, experiment });
    const reordered = configurationEvidenceFingerprint({ model: "model", modelOptions: reorderedOptions, experiment });
    const changed = configurationEvidenceFingerprint({
      model: "model",
      modelOptions: { ...firstOptions, temperature: 0.8 },
      experiment,
    });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("represents non-Git workspaces without manufacturing diff artifacts", async () => {
    const { store, targetPath } = await temporaryStore();
    const plan = evidencePlan("non-git-plan");
    const nonGit = executionBaseline({ gitHead: null, gitTree: null, gitStatus: null });
    const backend = new EvidenceFakeBackend({ baseline: nonGit });
    const originalOpen = backend.open.bind(backend);
    backend.open = async (input) => {
      const session = await originalOpen(input);
      const executeRun = session.executeRun.bind(session);
      return {
        ...session,
        executeRun: async (request) => {
          const result = await executeRun(request);
          return {
            ...result,
            workspace: {
              ...result.workspace,
              initialGitDiffFromHead: null,
              finalGitDiffFromHead: null,
            },
          };
        },
      };
    };
    await runStoredExperimentPlan({
      store,
      plan,
      backend,
      targetPath,
      executor: richExecutor(),
      now: deterministicClock(),
    });
    const stored = await store.readAttempt(plan.fingerprint, plan.plannedRuns[0]!.id, 1);
    expect(stored.manifest?.artifacts.initialGitDiffFromHead).toBeNull();
    expect(stored.manifest?.artifacts.finalGitDiffFromHead).toBeNull();
    expect(stored.manifest?.workspace.changes).toHaveLength(1);
    expect(stored.manifest?.workspace.initialGitDiffAvailable).toBe(false);
    expect(stored.manifest?.workspace.finalGitDiffAvailable).toBe(false);
  });
});
