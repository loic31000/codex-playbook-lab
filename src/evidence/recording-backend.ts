import {
  LocalRunExecutionError,
  type ExperimentExecutionBackend,
  type ExperimentExecutionSession,
  type BackendRunRequest,
  type BackendRunResult,
} from "../experiment/execution-backend.js";
import type { ExperimentRunEvent } from "../experiment/events.js";
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

interface PendingAttemptBase {
  readonly request: BackendRunRequest;
  readonly modelInput: ArtifactReference;
}

type PendingAttempt = PendingAttemptBase & (
  | { readonly kind: "process_exit"; readonly result: BackendRunResult }
  | { readonly kind: "execution_error"; readonly errorName: string }
);

export interface EvidenceStorageHooks {
  readonly afterManifestFinalizedBeforeCheckpoint?: (
    manifest: AttemptManifestRecord,
  ) => void | Promise<void>;
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
  readonly #pending = new Map<string, PendingAttempt>();
  readonly #hooks: EvidenceStorageHooks;
  #targetPath = "";
  #session: ExperimentExecutionSession | undefined;

  constructor(input: {
    readonly backend: ExperimentExecutionBackend;
    readonly store: FilesystemEvidenceStore;
    readonly plan: ExperimentExecutionPlan;
    readonly hooks?: EvidenceStorageHooks;
  }) {
    this.#backend = input.backend;
    this.#store = input.store;
    this.#plan = input.plan;
    this.#hooks = input.hooks ?? {};
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
        try {
          const result = await delegate.executeRun(request);
          this.#pending.set(attemptKey(request.plannedRun.id, request.attempt), {
            kind: "process_exit",
            request,
            result,
            modelInput,
          });
          return result;
        } catch (error) {
          if (error instanceof LocalRunExecutionError) {
            this.#pending.set(attemptKey(request.plannedRun.id, request.attempt), {
              kind: "execution_error",
              request,
              modelInput,
              errorName: error.name,
            });
          }
          throw error;
        }
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
      const manifest = await this.#finalize(state, logicalRun.run, pending);
      this.#pending.delete(key);
      await this.#hooks.afterManifestFinalizedBeforeCheckpoint?.(manifest);
    }
    await this.#store.appendCheckpoint(this.#plan, state, [this.#targetPath]);
  }

  async #finalize(
    state: ExperimentExecutionState,
    experimentRun: ExperimentExecutionState["runs"][number]["run"],
    pending: PendingAttempt,
  ): Promise<AttemptManifestRecord> {
    if (!this.#session) throw new Error("recording backend has no active session");
    if (!experimentRun.startedAt || !experimentRun.finishedAt) {
      throw new Error("a finalized ExperimentRun requires startedAt and finishedAt");
    }
    const { request, modelInput } = pending;
    const { experiment, testCase } = findPlannedRunContext(this.#plan, request.plannedRun);
    const terminalEvent = this.#terminalEvent(state, request, experimentRun.technicalStatus);
    const result = pending.kind === "process_exit" ? pending.result : null;
    const [finalOutput, stdout, stderr, initialGitDiffFromHead, finalGitDiffFromHead] = result
      ? await Promise.all([
          this.#store.putArtifact(result.transcript.finalOutput, TEXT_MEDIA_TYPE, [this.#targetPath]),
          this.#store.putArtifact(result.transcript.stdout, TEXT_MEDIA_TYPE, [this.#targetPath]),
          this.#store.putArtifact(result.transcript.stderr, TEXT_MEDIA_TYPE, [this.#targetPath]),
          result.workspace.initialGitDiffFromHead === null
            ? Promise.resolve(null)
            : this.#store.putArtifact(result.workspace.initialGitDiffFromHead, DIFF_MEDIA_TYPE, [this.#targetPath]),
          result.workspace.finalGitDiffFromHead === null
            ? Promise.resolve(null)
            : this.#store.putArtifact(result.workspace.finalGitDiffFromHead, DIFF_MEDIA_TYPE, [this.#targetPath]),
        ])
      : [null, null, null, null, null];
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
      durationMs: result?.durationMs ?? null,
      exitCode: result?.exitCode ?? null,
      changedFiles: result?.changedFiles ?? [],
      fingerprints: {
        prompt: promptEvidenceFingerprint(experiment.promptVersion),
        testCase: caseEvidenceFingerprint(testCase),
        target: targetEvidenceFingerprint(this.#plan.target, this.#session.baseline),
        runner: runnerEvidenceFingerprint(this.#session.baseline),
        configuration: result
          ? configurationEvidenceFingerprint({
              model: result.transcript.model,
              modelOptions: result.transcript.modelOptions,
              experiment,
            })
          : null,
        plan: this.#plan.fingerprint,
      },
      termination: pending.kind === "process_exit"
        ? { kind: "process_exit", exitCode: pending.result.exitCode }
        : { kind: "execution_error", errorName: pending.errorName },
      terminalEvent,
      agent: result
        ? { model: result.transcript.model, modelOptions: result.transcript.modelOptions }
        : null,
      artifacts: {
        modelInput,
        finalOutput,
        stdout,
        stderr,
        initialGitDiffFromHead,
        finalGitDiffFromHead,
      },
      baseline: this.#session.baseline,
      workspace: result
        ? {
            initialWorkspaceFingerprint: result.workspace.initialWorkspaceFingerprint,
            finalWorkspaceFingerprint: result.workspace.finalWorkspaceFingerprint,
            changes: result.workspace.changes,
            changedFiles: result.workspace.changedFiles,
            initialGitDiffAvailable: result.workspace.initialGitDiffFromHead !== null,
            finalGitDiffAvailable: result.workspace.finalGitDiffFromHead !== null,
          }
        : null,
      evidence: experimentRun.evidence,
      experiment,
      plannedRun: request.plannedRun,
      experimentRun,
      testCase,
      promptVersion: experiment.promptVersion,
    };
    await this.#store.finalizeAttempt(manifest, [this.#targetPath]);
    return manifest;
  }

  #terminalEvent(
    state: ExperimentExecutionState,
    request: BackendRunRequest,
    technicalStatus: string,
  ): AttemptManifestRecord["terminalEvent"] {
    const expectedType = technicalStatus === "completed" ? "run_completed" : "run_failed";
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index]!;
      if (
        event.type === expectedType
        && "plannedRunId" in event
        && event.plannedRunId === request.plannedRun.id
        && event.attempt === request.attempt
      ) {
        return event as ExperimentRunEvent & { type: "run_completed" | "run_failed" };
      }
    }
    throw new Error(`terminal event missing for ${request.plannedRun.id}/${request.attempt}`);
  }
}
