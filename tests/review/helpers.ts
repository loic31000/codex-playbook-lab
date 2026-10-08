import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEvidence } from "../../src/domain/index.js";
import {
  createExperimentExecutionPlan,
  sha256Exact,
  type BackendRunRequest,
  type ExecutionBaseline,
  type ExperimentExecutionBackend,
  type ExperimentExecutionSession,
} from "../../src/experiment/index.js";
import { openEvidenceStore, runStoredExperimentPlan, type FilesystemEvidenceStore } from "../../src/evidence/index.js";

export const reviewTarget = { id: "review-target", source: "git", revision: "review-revision" } as const;
export const exactGeneratedInput = "# Cas\r\n\r\nTexte avec espaces.  \r\nDernière ligne\r\n";
export const provenanceSentinel = "PROVENANCE_SENTINEL_29";
export const reviewCommentSentinel = "REVIEW_COMMENT_SENTINEL_29";
export const promotionCommentSentinel = "PROMOTION_COMMENT_SENTINEL_29";

export function reviewPlan(id = "human-review-plan", includeSeed = true) {
  const instruction = `Generate exact review case ${provenanceSentinel}`;
  return createExperimentExecutionPlan({
    id,
    experiments: [{
      id: "human-review-experiment",
      promptDefinition: { id: "09-01-implementer-story", name: "Implementer Story" },
      promptVersion: {
        id: "09-01-implementer-story@review-v1",
        promptDefinitionId: "09-01-implementer-story",
        content: "Apply only the requested story.",
      },
      target: reviewTarget,
      testCases: [{
        kind: "generated",
        id: "generated-review-case",
        title: "Generated review case",
        input: exactGeneratedInput,
        provenance: {
          generatorId: "review-generator",
          generatorVersion: "2.9.0",
          generatedAt: "2026-10-08T08:00:00.000Z",
          instruction: { kind: "content", value: instruction },
          instructionVersion: "review-v1",
          instructionFingerprint: sha256Exact(instruction),
          model: "generator-model",
          modelOptions: { temperature: 0.3, nested: { sentinel: provenanceSentinel } },
          target: reviewTarget,
          contentFingerprint: sha256Exact(exactGeneratedInput),
          reproducibility: "not_guaranteed",
          ...(includeSeed ? { seed: "review-seed" } : {}),
          parentRef: provenanceSentinel,
        },
      }],
      configuration: { repetitions: 1 },
      runs: [],
    }],
  });
}

function baseline(): ExecutionBaseline {
  return {
    target: reviewTarget,
    workspaceFingerprint: "review-workspace-initial",
    gitHead: "review-revision",
    gitTree: "review-tree",
    gitStatus: "",
    image: "review-runner:1",
    policyFingerprint: "review-policy",
  };
}

class ReviewBackend implements ExperimentExecutionBackend {
  async open(input: Parameters<ExperimentExecutionBackend["open"]>[0]): Promise<ExperimentExecutionSession> {
    const value = baseline();
    if (input.expectedBaseline && JSON.stringify(input.expectedBaseline) !== JSON.stringify(value)) {
      throw new Error("review baseline mismatch");
    }
    return {
      baseline: value,
      async executeRun(request: BackendRunRequest) {
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
            id: `review-env-${request.plannedRun.ordinal}`,
            volume: `review-volume-${request.plannedRun.ordinal}`,
            image: value.image,
            async exec() {
              return { code: 0, signal: null, stdout: "", stderr: "" };
            },
          },
        });
        return {
          exitCode: execution.exitCode,
          durationMs: 10 + request.plannedRun.ordinal,
          changedFiles: [],
          evidence: execution.evidence ?? [],
          transcript: execution.transcript,
          facts: {
            environmentId: `review-env-${request.plannedRun.ordinal}`,
            volume: `review-volume-${request.plannedRun.ordinal}`,
            image: value.image,
            initialWorkspaceFingerprint: value.workspaceFingerprint,
            initialGitHead: value.gitHead,
            initialGitTree: value.gitTree,
            initialGitStatus: value.gitStatus,
            policyFingerprint: value.policyFingerprint,
            finalWorkspaceFingerprint: value.workspaceFingerprint,
          },
          workspace: {
            initialWorkspaceFingerprint: value.workspaceFingerprint,
            finalWorkspaceFingerprint: value.workspaceFingerprint,
            changes: [],
            changedFiles: [],
            initialGitDiffFromHead: "",
            finalGitDiffFromHead: "",
          },
        };
      },
      async close() {},
    };
  }
}

export interface ReviewFixture {
  readonly root: string;
  readonly storeRoot: string;
  readonly benchmarksDir: string;
  readonly targetPath: string;
  readonly store: FilesystemEvidenceStore;
  readonly plan: ReturnType<typeof reviewPlan>;
}

export async function createReviewFixture(input: {
  readonly id?: string;
  readonly exitCodes?: readonly number[];
  readonly includeSeed?: boolean;
} = {}): Promise<ReviewFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-review-test-"));
  const storeRoot = path.join(root, "store");
  const benchmarksDir = path.join(root, "benchmarks");
  const targetPath = path.join(root, "target");
  await Promise.all([fs.mkdir(benchmarksDir), fs.mkdir(targetPath)]);
  const store = await openEvidenceStore(storeRoot);
  const plan = reviewPlan(input.id, input.includeSeed ?? true);
  const exitCodes = input.exitCodes ?? [0, 0];
  let tick = 0;
  await runStoredExperimentPlan({
    store,
    plan,
    backend: new ReviewBackend(),
    targetPath,
    now: () => new Date(Date.UTC(2026, 9, 8, 8, 1, tick++)),
    executor: {
      async execute({ plannedRun }) {
        const exitCode = exitCodes[plannedRun.ordinal - 1] ?? 0;
        return {
          exitCode,
          evidence: [createEvidence({
            type: exitCode === 0 ? "tests-passed" : "tests-failed",
            source: "review-test",
            recordedAt: "2026-10-08T08:01:00.000Z",
            data: { exitCode },
          })],
          transcript: {
            model: "review-agent",
            modelOptions: { temperature: 0 },
            finalOutput: `run ${plannedRun.ordinal}`,
            stdout: "",
            stderr: "",
          },
        };
      },
    },
  });
  return { root, storeRoot, benchmarksDir, targetPath, store, plan };
}

export async function removeReviewFixture(fixture: ReviewFixture): Promise<void> {
  await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
