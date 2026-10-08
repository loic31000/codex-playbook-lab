import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEvidence } from "../../src/domain/index.js";
import {
  canonicalJson,
  createExperimentExecutionPlan,
  sha256Exact,
  type BackendRunRequest,
  type ExecutionBaseline,
  type ExperimentExecutionBackend,
  type ExperimentExecutionSession,
} from "../../src/experiment/index.js";
import { openEvidenceStore, runStoredExperimentPlan, type FilesystemEvidenceStore } from "../../src/evidence/index.js";
import { recordHumanReview } from "../../src/review/index.js";

const target = { id: "report-target", source: "git", revision: "report-revision" } as const;

export function reportPlan(id = "human-report-plan") {
  return createExperimentExecutionPlan({
    id,
    experiments: [{
      id: "report-experiment",
      promptDefinition: { id: "report-prompt", name: "Report prompt" },
      promptVersion: {
        id: "report-prompt@v1",
        promptDefinitionId: "report-prompt",
        content: "Apply report prompt facts only.",
      },
      target,
      testCases: [
        { kind: "fixed", id: "case-alpha", title: "Alpha | case", input: "Alpha input" },
        { kind: "fixed", id: "case-beta", title: "Beta case", input: "Beta input" },
      ],
      configuration: { repetitions: 1 },
      runs: [],
    }],
  });
}

function baseline(): ExecutionBaseline {
  return {
    target,
    workspaceFingerprint: "report-workspace-initial",
    gitHead: "report-revision",
    gitTree: "report-tree",
    gitStatus: "",
    image: "report-runner:1",
    policyFingerprint: "report-policy",
  };
}

const durations = [100, 150, 90, 110] as const;
const changedFiles = [
  ["src/base-only.ts", "src/shared.ts"],
  ["src/shared.ts", "src/treatment-only.ts"],
  [],
  ["src/case-two.ts"],
] as const;

class ReportBackend implements ExperimentExecutionBackend {
  constructor(private readonly crashOnOrdinal: number | null = null) {}

  async open(input: Parameters<ExperimentExecutionBackend["open"]>[0]): Promise<ExperimentExecutionSession> {
    const value = baseline();
    if (input.expectedBaseline && canonicalJson(input.expectedBaseline) !== canonicalJson(value)) {
      throw new Error("report baseline mismatch");
    }
    return {
      baseline: value,
      executeRun: async (request: BackendRunRequest) => {
        if (request.plannedRun.ordinal === this.crashOnOrdinal) throw new Error("simulated report process crash");
        const execution = await request.executor.execute({
          plannedRun: request.plannedRun,
          experiment: request.experiment,
          testCase: request.testCase,
          promptVersion: request.experiment.promptVersion,
          variant: request.plannedRun.variant,
          repetition: request.plannedRun.repetition,
          modelInput: request.modelInput,
          signal: request.signal,
          environment: {
            id: `report-environment-${request.plannedRun.ordinal}`,
            volume: `report-volume-${request.plannedRun.ordinal}`,
            image: value.image,
            async exec() {
              return { code: 0, signal: null, stdout: "", stderr: "" };
            },
          },
        });
        const files = [...changedFiles[request.plannedRun.ordinal - 1]!];
        return {
          exitCode: execution.exitCode,
          durationMs: durations[request.plannedRun.ordinal - 1]!,
          changedFiles: files,
          evidence: execution.evidence ?? [],
          transcript: execution.transcript,
          facts: {
            environmentId: `report-environment-${request.plannedRun.ordinal}`,
            volume: `report-volume-${request.plannedRun.ordinal}`,
            image: value.image,
            initialWorkspaceFingerprint: value.workspaceFingerprint,
            initialGitHead: value.gitHead,
            initialGitTree: value.gitTree,
            initialGitStatus: value.gitStatus,
            policyFingerprint: value.policyFingerprint,
            finalWorkspaceFingerprint: `report-workspace-${request.plannedRun.ordinal}`,
          },
          workspace: {
            initialWorkspaceFingerprint: value.workspaceFingerprint,
            finalWorkspaceFingerprint: `report-workspace-${request.plannedRun.ordinal}`,
            changes: files.map((filename) => ({
              path: filename,
              status: "modified" as const,
              before: { kind: "file" as const, sha256: sha256Exact(`before:${filename}`) },
              after: { kind: "file" as const, sha256: sha256Exact(`after:${request.plannedRun.ordinal}:${filename}`) },
            })),
            changedFiles: files,
            initialGitDiffFromHead: "",
            finalGitDiffFromHead: files.map((filename) => `diff --git a/${filename} b/${filename}`).join("\n"),
          },
        };
      },
      async close() {},
    };
  }
}

export interface ReportFixture {
  readonly root: string;
  readonly storeRoot: string;
  readonly targetPath: string;
  readonly store: FilesystemEvidenceStore;
  readonly plan: ReturnType<typeof reportPlan>;
}

export async function createEmptyReportFixture(id = "empty-report-plan"): Promise<ReportFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-report-test-"));
  const storeRoot = path.join(root, "store");
  const targetPath = path.join(root, "target");
  await fs.mkdir(targetPath);
  const store = await openEvidenceStore(storeRoot);
  const plan = reportPlan(id);
  await store.writePlan(plan, [targetPath]);
  return { root, storeRoot, targetPath, store, plan };
}

export async function createCompleteReportFixture(
  id = "complete-report-plan",
  withReviews = true,
): Promise<ReportFixture> {
  const fixture = await createEmptyReportFixture(id);
  const exitCodes = [0, 2, 0, 0];
  const passed = [3, 2, 4, 4];
  const failed = [0, 1, 0, 0];
  let tick = 0;
  await runStoredExperimentPlan({
    store: fixture.store,
    plan: fixture.plan,
    backend: new ReportBackend(),
    targetPath: fixture.targetPath,
    now: () => new Date(Date.UTC(2026, 9, 9, 8, 0, tick++)),
    executor: {
      async execute({ plannedRun }) {
        const index = plannedRun.ordinal - 1;
        return {
          exitCode: exitCodes[index]!,
          evidence: [
            createEvidence({
              type: "test-result",
              source: "report-fixture",
              recordedAt: `2026-10-09T09:0${index}:00.000Z`,
              metric: { name: "tests.passed", value: passed[index]!, unit: "count" },
            }),
            createEvidence({
              type: "test-result",
              source: "report-fixture",
              recordedAt: `2026-10-09T09:0${index}:01.000Z`,
              metric: { name: "tests.failed", value: failed[index]!, unit: "count" },
            }),
            createEvidence({
              type: "command-execution",
              source: "report-fixture",
              recordedAt: `2026-10-09T09:0${index}:02.000Z`,
              data: { command: "npm test", exitCode: exitCodes[index]! },
            }),
          ],
          transcript: {
            model: "report-agent",
            modelOptions: { temperature: 0, nested: { mode: "facts" } },
            finalOutput: `output-${plannedRun.ordinal}`,
            stdout: `stdout-${plannedRun.ordinal}\n`,
            stderr: `stderr-${plannedRun.ordinal}\n`,
          },
        };
      },
    },
  });
  const reviews = withReviews ? [
    { index: 0, status: "approved" as const, reviewer: "Alice | QA", comment: "Human **comment**\n# alpha" },
    { index: 1, status: "rejected" as const, reviewer: "Bob", comment: "Observed failure" },
    { index: 3, status: "uncertain" as const, reviewer: "Chloé", comment: "Needs follow-up" },
  ] : [];
  for (const [reviewIndex, review] of reviews.entries()) {
    await recordHumanReview({
      store: fixture.store,
      planFingerprint: fixture.plan.fingerprint,
      plannedRunId: fixture.plan.plannedRuns[review.index]!.id,
      status: review.status,
      reviewer: review.reviewer,
      reviewedAt: `2026-10-09T10:0${reviewIndex}:00.000Z`,
      comment: review.comment,
    });
  }
  return fixture;
}

export async function createCrashedReportFixture(id = "crashed-report-plan"): Promise<ReportFixture> {
  const fixture = await createEmptyReportFixture(id);
  let tick = 0;
  await runStoredExperimentPlan({
    store: fixture.store,
    plan: fixture.plan,
    backend: new ReportBackend(2),
    targetPath: fixture.targetPath,
    now: () => new Date(Date.UTC(2026, 9, 9, 11, 0, tick++)),
    executor: {
      async execute({ plannedRun }) {
        return {
          exitCode: 0,
          evidence: [],
          transcript: {
            model: "report-agent",
            modelOptions: {},
            finalOutput: `partial-${plannedRun.ordinal}`,
            stdout: "",
            stderr: "",
          },
        };
      },
    },
  }).then(
    () => { throw new Error("expected report fixture crash"); },
    (error: unknown) => {
      if (!(error instanceof Error) || !/simulated report process crash/.test(error.message)) throw error;
    },
  );
  return fixture;
}

export async function createInterruptedReportFixture(id = "interrupted-report-plan"): Promise<ReportFixture> {
  const fixture = await createEmptyReportFixture(id);
  const controller = new AbortController();
  let tick = 0;
  await runStoredExperimentPlan({
    store: fixture.store,
    plan: fixture.plan,
    backend: new ReportBackend(),
    targetPath: fixture.targetPath,
    signal: controller.signal,
    now: () => new Date(Date.UTC(2026, 9, 9, 11, 30, tick++)),
    executor: {
      async execute({ plannedRun }) {
        if (plannedRun.ordinal === 2) {
          controller.abort();
          throw Object.assign(new Error("interrupted report execution"), { name: "AbortError" });
        }
        return {
          exitCode: 0,
          evidence: [],
          transcript: {
            model: "report-agent",
            modelOptions: {},
            finalOutput: `interrupted-${plannedRun.ordinal}`,
            stdout: "",
            stderr: "",
          },
        };
      },
    },
  });
  return fixture;
}

export async function createManifestAheadFixture(id = "ahead-report-plan"): Promise<ReportFixture> {
  const fixture = await createEmptyReportFixture(id);
  let tick = 0;
  await runStoredExperimentPlan({
    store: fixture.store,
    plan: fixture.plan,
    backend: new ReportBackend(),
    targetPath: fixture.targetPath,
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
    executor: {
      async execute({ plannedRun }) {
        return {
          exitCode: 0,
          evidence: [],
          transcript: {
            model: "report-agent",
            modelOptions: {},
            finalOutput: `ahead-${plannedRun.ordinal}`,
            stdout: "",
            stderr: "",
          },
        };
      },
    },
    storageHooks: {
      afterManifestFinalizedBeforeCheckpoint() {
        throw new Error("simulated crash after report manifest");
      },
    },
  }).then(
    () => { throw new Error("expected manifest-ahead fixture crash"); },
    (error: unknown) => {
      if (!(error instanceof Error) || !/simulated crash after report manifest/.test(error.message)) throw error;
    },
  );
  return fixture;
}

export async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const output: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => (
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).replaceAll("\\", "/");
        output[relative] = crypto.createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
      }
    }
  }
  await visit(root);
  return output;
}

export async function removeReportFixture(fixture: ReportFixture): Promise<void> {
  await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
