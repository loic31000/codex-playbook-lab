import type {
  GenerationProvenance,
  HumanReviewStatus,
} from "../domain/index.js";
import type { ExperimentVariant } from "../experiment/model-input.js";

export const PROMOTED_BENCHMARK_FORMAT = "codex-lab-benchmark-v2";
export const PROMOTION_METADATA_FORMAT = "codex-lab-benchmark-promotion";
export const PROMOTION_METADATA_VERSION = 1;

export type PromotionExpectation = "implementation" | "clarification";

export interface HumanReviewAuditRecord {
  readonly format: "codex-playbook-lab-evidence";
  readonly version: 1;
  readonly kind: "human-review";
  readonly sequence: number;
  readonly recordFingerprint: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly attempt: number;
  readonly experimentId: string;
  readonly promptVersionId: string;
  readonly testCaseId: string;
  readonly variant: ExperimentVariant;
  readonly repetition: number;
  readonly sourceAttemptRef: string;
  readonly sourceAttemptFingerprint: string;
  readonly previousStatus: HumanReviewStatus;
  readonly status: HumanReviewStatus;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly comment?: string;
}

export interface PromotionSourceGeneratedCase {
  readonly id: string;
  readonly title: string;
  readonly contentFingerprint: string;
  readonly provenance: GenerationProvenance;
}

export interface PromotionSourceReference {
  readonly planId: string;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly attempt: number;
  readonly sourceAttemptRef: string;
  readonly sourceAttemptFingerprint: string;
  readonly reviewSequence: number;
  readonly reviewFingerprint: string;
  readonly review: HumanReviewAuditRecord;
}

export interface FixedBenchmarkPromotionMetadata {
  readonly format: typeof PROMOTION_METADATA_FORMAT;
  readonly version: typeof PROMOTION_METADATA_VERSION;
  readonly fixedCaseId: string;
  readonly promptDefinitionId: string;
  readonly expectation: PromotionExpectation;
  readonly sourceGeneratedCase: PromotionSourceGeneratedCase;
  readonly source: PromotionSourceReference;
  readonly promotion: {
    readonly promotedBy: string;
    readonly promotedAt: string;
    readonly comment?: string;
  };
}

export interface CasePromotionAuditRecord {
  readonly format: "codex-playbook-lab-evidence";
  readonly version: 1;
  readonly kind: "case-promotion";
  readonly recordFingerprint: string;
  readonly sourceGeneratedCase: PromotionSourceGeneratedCase;
  readonly source: PromotionSourceReference;
  readonly fixedCaseId: string;
  readonly promptDefinitionId: string;
  readonly expectation: PromotionExpectation;
  readonly benchmarkPath: string;
  readonly metadataPath: string;
  readonly promotedBy: string;
  readonly promotedAt: string;
  readonly comment?: string;
}

export interface CurrentHumanReview {
  readonly status: HumanReviewStatus;
  readonly latest: HumanReviewAuditRecord | null;
}
