import type {
  Evidence,
  Experiment,
  ExperimentRun,
  JsonObject,
  PromptVersion,
  TestCase,
} from "../domain/index.js";
import type {
  AgentExecutionTranscript,
  ExecutionBaseline,
  WorkspaceExecutionResult,
} from "../experiment/execution-backend.js";
import type { ExperimentExecutionState } from "../experiment/orchestrator.js";
import type { ExperimentExecutionPlan, PlannedRun } from "../experiment/plan.js";

export const EVIDENCE_STORE_FORMAT = "codex-playbook-lab-evidence";
export const EVIDENCE_STORE_VERSION = 1;

export type EvidenceRecordKind = "store" | "plan" | "checkpoint" | "attempt-started" | "attempt-manifest";

export interface EvidenceRecordHeader {
  readonly format: typeof EVIDENCE_STORE_FORMAT;
  readonly version: typeof EVIDENCE_STORE_VERSION;
  readonly kind: EvidenceRecordKind;
}

export interface ArtifactReference {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly ref: string;
}

export interface EvidenceFingerprints {
  readonly prompt: string;
  readonly testCase: string;
  readonly target: string;
  readonly runner: string;
  readonly configuration: string;
  readonly plan: string;
}

export type AttemptStartFingerprints = Omit<EvidenceFingerprints, "configuration">;

export interface StoreFormatRecord extends EvidenceRecordHeader {
  readonly kind: "store";
}

export interface StoredPlanRecord extends EvidenceRecordHeader {
  readonly kind: "plan";
  readonly planFingerprint: string;
  readonly plan: ExperimentExecutionPlan;
}

export interface StoredCheckpointRecord extends EvidenceRecordHeader {
  readonly kind: "checkpoint";
  readonly sequence: number;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly stateFingerprint: string;
  readonly state: ExperimentExecutionState;
}

export interface AttemptStartedRecord extends EvidenceRecordHeader {
  readonly kind: "attempt-started";
  readonly planId: string;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly attempt: number;
  readonly experimentId: string;
  readonly promptVersionId: string;
  readonly testCaseId: string;
  readonly variant: PlannedRun["variant"];
  readonly repetition: number;
  readonly startedAt: string;
  readonly fingerprints: AttemptStartFingerprints;
  readonly modelInput: ArtifactReference;
  readonly baseline: ExecutionBaseline;
}

export interface AttemptArtifactReferences {
  readonly modelInput: ArtifactReference;
  readonly finalOutput: ArtifactReference;
  readonly stdout: ArtifactReference;
  readonly stderr: ArtifactReference;
  readonly initialGitDiffFromHead: ArtifactReference | null;
  readonly finalGitDiffFromHead: ArtifactReference | null;
}

export interface StoredAgentExecution {
  readonly model: string;
  readonly modelOptions: JsonObject;
}

export interface StoredWorkspaceExecution extends Omit<
  WorkspaceExecutionResult,
  "initialGitDiffFromHead" | "finalGitDiffFromHead"
> {
  readonly initialGitDiffAvailable: boolean;
  readonly finalGitDiffAvailable: boolean;
}

export interface AttemptManifestRecord extends EvidenceRecordHeader {
  readonly kind: "attempt-manifest";
  readonly planId: string;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly attempt: number;
  readonly experimentId: string;
  readonly promptVersionId: string;
  readonly testCaseId: string;
  readonly variant: PlannedRun["variant"];
  readonly repetition: number;
  readonly technicalStatus: ExperimentRun["technicalStatus"];
  readonly humanReviewStatus: ExperimentRun["humanReviewStatus"];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly changedFiles: readonly string[];
  readonly fingerprints: EvidenceFingerprints;
  readonly agent: StoredAgentExecution;
  readonly artifacts: AttemptArtifactReferences;
  readonly baseline: ExecutionBaseline;
  readonly workspace: StoredWorkspaceExecution;
  readonly evidence: readonly Evidence[];
  readonly experiment: Experiment;
  readonly plannedRun: PlannedRun;
  readonly experimentRun: ExperimentRun;
  readonly testCase: TestCase;
  readonly promptVersion: PromptVersion;
}

export interface LatestCheckpointResult {
  readonly checkpoint: StoredCheckpointRecord | null;
  readonly invalidCheckpointRefs: readonly string[];
}

export interface RunAttemptSummary {
  readonly attempt: number;
  readonly status: "partial" | "finalized";
  readonly startedRef: string;
  readonly manifestRef: string | null;
}

export interface StoredRunAttempt {
  readonly summary: RunAttemptSummary;
  readonly started: AttemptStartedRecord;
  readonly manifest: AttemptManifestRecord | null;
}

export interface FinalizeAttemptInput {
  readonly plan: ExperimentExecutionPlan;
  readonly experiment: Experiment;
  readonly plannedRun: PlannedRun;
  readonly testCase: TestCase;
  readonly promptVersion: PromptVersion;
  readonly experimentRun: ExperimentRun;
  readonly attempt: number;
  readonly baseline: ExecutionBaseline;
  readonly transcript: AgentExecutionTranscript;
  readonly workspace: WorkspaceExecutionResult;
  readonly durationMs: number;
  readonly exitCode: number;
}
