import type {
  Evidence,
  HumanReviewStatus,
  TechnicalStatus,
} from "../domain/index.js";
import type {
  ArtifactReference,
  AttemptTermination,
  EvidenceFingerprints,
  RunAttemptSummary,
} from "../evidence/index.js";
import type { ExperimentExecutionStatus, ExperimentVariant } from "../experiment/index.js";

export const EXPERIMENT_REPORT_FORMAT = "codex-playbook-lab-report";
export const EXPERIMENT_REPORT_VERSION = 1;

export type ReportCompletenessReason =
  | "no_checkpoint"
  | "execution_pending"
  | "execution_running"
  | "execution_interrupted"
  | "non_terminal_runs"
  | "partial_attempts"
  | "finalized_attempt_ahead_of_checkpoint";

export interface ReportSourceCheckpoint {
  readonly ref: string;
  readonly sequence: number;
  readonly stateFingerprint: string;
  readonly executionStatus: ExperimentExecutionStatus;
}

export interface ReportHumanReviewAction {
  readonly sequence: number;
  readonly previousStatus: HumanReviewStatus;
  readonly status: HumanReviewStatus;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly comment?: string;
  readonly sourceRef: string;
  readonly recordFingerprint: string;
  readonly sourceAttemptRef: string;
  readonly sourceAttemptFingerprint: string;
}

export interface ReportHumanReview {
  readonly status: HumanReviewStatus;
  readonly origin: "default_pending" | "human_action";
  readonly reviewer?: string;
  readonly reviewedAt?: string;
  readonly comment?: string;
  readonly sequence?: number;
  readonly sourceRef?: string;
  readonly recordFingerprint?: string;
  readonly history: readonly ReportHumanReviewAction[];
}

export interface ReportAttempt extends RunAttemptSummary {
  readonly startedFingerprint: string;
  readonly manifestFingerprint: string | null;
  readonly modelInput: ArtifactReference;
}

export interface ReportManifestSource {
  readonly ref: string;
  readonly fingerprint: string;
  readonly termination: AttemptTermination;
  readonly fingerprints: EvidenceFingerprints;
  readonly artifacts: {
    readonly modelInput: ArtifactReference;
    readonly finalOutput: ArtifactReference | null;
    readonly stdout: ArtifactReference | null;
    readonly stderr: ArtifactReference | null;
    readonly initialGitDiffFromHead: ArtifactReference | null;
    readonly finalGitDiffFromHead: ArtifactReference | null;
  };
  readonly workspaceKnown: boolean;
}

export interface ExperimentReportRun {
  readonly plannedRunId: string;
  readonly ordinal: number;
  readonly experimentId: string;
  readonly promptVersionId: string;
  readonly testCase: {
    readonly id: string;
    readonly title: string;
    readonly kind: "fixed" | "generated";
    readonly inputFingerprint: string;
  };
  readonly variant: ExperimentVariant;
  readonly repetition: number;
  readonly attempt: number;
  readonly technicalStatus: TechnicalStatus;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly changedFiles?: readonly string[];
  readonly evidence?: readonly Evidence[];
  readonly attempts: readonly ReportAttempt[];
  readonly manifest: ReportManifestSource | null;
  readonly humanReview: ReportHumanReview;
}

export interface ReportCountSources {
  readonly count: number;
  readonly plannedRunIds: readonly string[];
}

export interface ReportDurationSummary {
  readonly knownRunCount: number;
  readonly totalMs: number | null;
  readonly observations: readonly {
    readonly plannedRunId: string;
    readonly durationMs: number;
    readonly sourceManifestRef: string;
  }[];
}

export interface ReportChangedFilesSummary {
  readonly knownRunCount: number;
  readonly runsWithChanges: ReportCountSources;
  readonly runsWithoutChanges: ReportCountSources;
  readonly union: readonly {
    readonly path: string;
    readonly plannedRunIds: readonly string[];
    readonly sourceManifestRefs: readonly string[];
  }[];
}

export interface ReportEvidenceTypeSummary {
  readonly type: string;
  readonly count: number;
  readonly sources: readonly {
    readonly plannedRunId: string;
    readonly evidenceIndex: number;
    readonly manifestRef: string;
  }[];
}

export interface ReportMetricSummary {
  readonly name: string;
  readonly unit: string | null;
  readonly observationCount: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly observations: readonly {
    readonly plannedRunId: string;
    readonly evidenceIndex: number;
    readonly value: number;
    readonly manifestRef: string;
  }[];
}

export interface ExperimentReportComparison {
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly repetition: number;
  readonly pairTerminal: boolean;
  readonly factsComplete: boolean;
  readonly missingFacts: readonly string[];
  readonly baseline: {
    readonly plannedRunId: string;
    readonly technicalStatus: TechnicalStatus;
    readonly exitCode?: number;
    readonly durationMs?: number;
    readonly evidenceTypeCounts: readonly { readonly type: string; readonly count: number }[];
  };
  readonly treatment: {
    readonly plannedRunId: string;
    readonly technicalStatus: TechnicalStatus;
    readonly exitCode?: number;
    readonly durationMs?: number;
    readonly evidenceTypeCounts: readonly { readonly type: string; readonly count: number }[];
  };
  readonly treatmentMinusBaselineMs?: number;
  readonly changedFiles?: {
    readonly shared: readonly string[];
    readonly baselineOnly: readonly string[];
    readonly treatmentOnly: readonly string[];
  };
  readonly fingerprints?: {
    readonly sameTestCaseFingerprint: boolean;
    readonly sameTargetFingerprint: boolean;
    readonly sameRunnerFingerprint: boolean;
    readonly sameConfigurationFingerprint: boolean;
  };
  readonly artifacts?: {
    readonly sameFinalOutputSha256: boolean;
  };
}

export interface ExperimentReport {
  readonly format: typeof EXPERIMENT_REPORT_FORMAT;
  readonly version: typeof EXPERIMENT_REPORT_VERSION;
  readonly plan: {
    readonly id: string;
    readonly fingerprint: string;
    readonly plannedRunCount: number;
    readonly target: {
      readonly id: string;
      readonly source: string;
      readonly revision?: string;
    };
  };
  readonly source: {
    readonly planRef: string;
    readonly checkpoint: ReportSourceCheckpoint | null;
  };
  readonly completeness: {
    readonly complete: boolean;
    readonly reasons: readonly ReportCompletenessReason[];
  };
  readonly summary: {
    readonly technicalStatuses: Readonly<Record<TechnicalStatus, ReportCountSources>>;
    readonly humanReviewStatuses: Readonly<Record<HumanReviewStatus, ReportCountSources>>;
    readonly pendingReviewRunIds: readonly string[];
    readonly reviewActions: {
      readonly count: number;
      readonly sources: readonly {
        readonly plannedRunId: string;
        readonly sequence: number;
        readonly sourceRef: string;
        readonly recordFingerprint: string;
      }[];
    };
    readonly durations: ReportDurationSummary;
    readonly changedFiles: ReportChangedFilesSummary;
    readonly evidenceTypes: readonly ReportEvidenceTypeSummary[];
    readonly metrics: readonly ReportMetricSummary[];
  };
  readonly runs: readonly ExperimentReportRun[];
  readonly comparisons: readonly ExperimentReportComparison[];
}
