import type { ExperimentExecutionBackend, ExperimentExecutionSession, BackendRunRequest, BackendRunResult } from "../experiment/execution-backend.js";
import type { ExperimentExecutionState } from "../experiment/orchestrator.js";
import { findPlannedRunContext, type ExperimentExecutionPlan } from "../experiment/plan.js";
import {
  caseEvidenceFingerprint,
  configurationEvidenceFingerprint,
  promptEvidenceFingerprint,
  runnerEvidenceFingerprint,
  targetEvidenceFingerprint,
} from "./fingerprints.js";
import { FilesystemEvidenceStore } from "./filesystem-evidence-store.js";
import {
  EVIDENCE_STORE_FORMAT,
  EVIDENCE_STORE_VERSION,
  type ArtifactReference,
  type AttemptManifestRecord,
  type AttemptStartedRecord,
} from "./schema.js";

interface PendingResult {
  readonly request: BackendRunRequest;
  readonly result: BackendRunResult;
  readonly modelInput: ArtifactReference;
}

function attemptKey(plannedRunId: string, attempt: number): string {
  return `${plannedRunId}\u0000${attempt}`;
}

const TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";
const DIFF_MEDIA_TYPE = "text/x-diff; charset=utf-8";

export class RecordingExperimentExecutionBackend implements ExperimentExecutionBackend {
  readonly #backend: ExperimentExecutionBackend;
  readonly #store: FilesystemEvidenceStore;
  readonly #plan: ExperimentExecutionPlan;
  readonly #pending = new Map<string, PendingResult>();
  #targetPath = "";
  #session: ExperimentExecutionSession | undefined;

  constructor(input: {
    readonly backend: ExperimentExecutionBackend;
    readonly store: FilesystemEvidenceStore;
    readonly plan: ExperimentExecutionPlan;
  }) {
    this.#backend = input.backend;
    this.#store = input.store;
    this.#plan = input.plan;
  }

  async open(input: Parameters<ExperimentExecutionBackend["open"]>[0]): Promise<ExperimentExecutionSession> {
    this.#targetPath = input.targetPath;
    const delegate = await this.#backend.open(input);
    this.#session = delegate;
    return {
      baseline: delegate.baseline,
      executeRun: async (request) => {
        const modelInput = await this.#store.putArtifact(request.modelInput, TEXT_MEDIA_TYPE, [this.#targetPath]);
        const started: AttemptStartedRecord = {
          format: EVIDENCE_STORE_FORMAT,
          version: EVIDENCE_STORE_VERSION,
          kind: "attempt-started",
          planId: this.#plan.id,
          planFingerprint: this.#plan.fingerprint,
          plannedRunId: request.plannedRun.id,
          attempt: request.attempt,
          experimentId: request.plannedRun.experimentId,
          promptVersionId: request.plannedRun.promptVersionId,
          testCaseId: request.plannedRun.testCaseId,
          variant: request.plannedRun.variant,
          repetition: request.plannedRun.repetition,
          startedAt: request.startedAt,
          fingerprints: {
            prompt: promptEvidenceFingerprint(request.experiment.promptVersion),
            testCase: caseEvidenceFingerprint(request.testCase),
            target: targetEvidenceFingerprint(this.#plan.target, delegate.baseline),
            runner: runnerEvidenceFingerprint(delegate.baseline),
            plan: this.#plan.fingerprint,
          },
          modelInput,
          baseline: delegate.baseline,
        };
        await this.#store.writeAttemptStarted(started, [this.#targetPath]);
        const result = await delegate.executeRun(request);
        this.#pending.set(attemptKey(request.plannedRun.id, request.attempt), { request, result, modelInput });
        return result;
      },
      close: async () => delegate.close(),
    };
  }

  async checkpoint(state: ExperimentExecutionState): Promise<void> {
    if (!this.#session) throw new Error("recording backend has not acquired an execution baseline");
    for (const logicalRun of state.runs) {
      if (logicalRun.run.technicalStatus !== "completed" && logicalRun.run.technicalStatus !== "failed") continue;
      const key = attemptKey(logicalRun.plannedRunId, logicalRun.attempt);
      const pending = this.#pending.get(key);
      if (!pending) continue;
      await this.#finalize(logicalRun.run, pending);
      this.#pending.delete(key);
    }
    await this.#store.appendCheckpoint(this.#plan, state, [this.#targetPath]);
  }

  async #finalize(
    experimentRun: ExperimentExecutionState["runs"][number]["run"],
    pending: PendingResult,
  ): Promise<void> {
    if (!this.#session) throw new Error("recording backend has no active session");
    if (!experimentRun.startedAt || !experimentRun.finishedAt) {
      throw new Error("a finalized ExperimentRun requires startedAt and finishedAt");
    }
    const { request, result, modelInput } = pending;
    const { experiment, testCase } = findPlannedRunContext(this.#plan, request.plannedRun);
    const [finalOutput, stdout, stderr, initialGitDiffFromHead, finalGitDiffFromHead] = await Promise.all([
      this.#store.putArtifact(result.transcript.finalOutput, TEXT_MEDIA_TYPE, [this.#targetPath]),
      this.#store.putArtifact(result.transcript.stdout, TEXT_MEDIA_TYPE, [this.#targetPath]),
      this.#store.putArtifact(result.transcript.stderr, TEXT_MEDIA_TYPE, [this.#targetPath]),
      result.workspace.initialGitDiffFromHead === null
        ? Promise.resolve(null)
        : this.#store.putArtifact(result.workspace.initialGitDiffFromHead, DIFF_MEDIA_TYPE, [this.#targetPath]),
      result.workspace.finalGitDiffFromHead === null
        ? Promise.resolve(null)
        : this.#store.putArtifact(result.workspace.finalGitDiffFromHead, DIFF_MEDIA_TYPE, [this.#targetPath]),
    ]);
    const manifest: AttemptManifestRecord = {
      format: EVIDENCE_STORE_FORMAT,
      version: EVIDENCE_STORE_VERSION,
      kind: "attempt-manifest",
      planId: this.#plan.id,
      planFingerprint: this.#plan.fingerprint,
      plannedRunId: request.plannedRun.id,
      attempt: request.attempt,
      experimentId: request.plannedRun.experimentId,
      promptVersionId: request.plannedRun.promptVersionId,
      testCaseId: request.plannedRun.testCaseId,
      variant: request.plannedRun.variant,
      repetition: request.plannedRun.repetition,
      technicalStatus: experimentRun.technicalStatus,
      humanReviewStatus: experimentRun.humanReviewStatus,
      startedAt: experimentRun.startedAt,
      finishedAt: experimentRun.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      changedFiles: result.changedFiles,
      fingerprints: {
        prompt: promptEvidenceFingerprint(experiment.promptVersion),
        testCase: caseEvidenceFingerprint(testCase),
        target: targetEvidenceFingerprint(this.#plan.target, this.#session.baseline),
        runner: runnerEvidenceFingerprint(this.#session.baseline),
        configuration: configurationEvidenceFingerprint({
          model: result.transcript.model,
          modelOptions: result.transcript.modelOptions,
          experiment,
        }),
        plan: this.#plan.fingerprint,
      },
      agent: {
        model: result.transcript.model,
        modelOptions: result.transcript.modelOptions,
      },
      artifacts: {
        modelInput,
        finalOutput,
        stdout,
        stderr,
        initialGitDiffFromHead,
        finalGitDiffFromHead,
      },
      baseline: this.#session.baseline,
      workspace: {
        initialWorkspaceFingerprint: result.workspace.initialWorkspaceFingerprint,
        finalWorkspaceFingerprint: result.workspace.finalWorkspaceFingerprint,
        changes: result.workspace.changes,
        changedFiles: result.workspace.changedFiles,
        initialGitDiffAvailable: result.workspace.initialGitDiffFromHead !== null,
        finalGitDiffAvailable: result.workspace.finalGitDiffFromHead !== null,
      },
      evidence: experimentRun.evidence,
      experiment,
      plannedRun: request.plannedRun,
      experimentRun,
      testCase,
      promptVersion: experiment.promptVersion,
    };
    await this.#store.finalizeAttempt(manifest, [this.#targetPath]);
  }
}
