import crypto from "node:crypto";

import {
  createExperiment,
  type HumanReviewStatus,
  type PromptDefinition,
  type PromptVersion,
  type TargetRef,
  type TestCase,
} from "../domain/index.js";
import {
  runStoredExperimentPlan,
  type ArtifactReference,
  type FilesystemEvidenceStore,
} from "../evidence/index.js";
import {
  createExperimentExecutionPlan,
  type ExperimentExecutionEvent,
  type ExperimentExecutionPlan,
  type ExperimentExecutionState,
} from "../experiment/index.js";
import {
  generateExploratoryCases,
  type GenerateCasesInput,
  type GeneratedCasesResult,
} from "../explore/index.js";
import {
  discoverFixedBenchmarks,
  discoverPrompts,
  selectFixedBenchmarks,
  selectPrompts,
  type DiscoveredPrompt,
  type FixedBenchmarkDefinition,
} from "../fixed/index.js";
import {
  buildExperimentReport,
  renderExperimentReportMarkdown,
  serializeExperimentReportJson,
  type ExperimentReport,
} from "../report/index.js";
import {
  PromotionConflictError,
  PromotionIntegrityError,
  ReviewConflictError,
  ReviewIntegrityError,
  ReviewNotFoundError,
  promoteGeneratedCase,
  readCurrentHumanReview,
  readHumanReviewHistory,
  recordHumanReview,
  type CurrentHumanReview,
  type HumanReviewAuditRecord,
  type PromoteGeneratedCaseInput,
  type PromotedGeneratedCaseResult,
  type PromotionExpectation,
} from "../review/index.js";
import type { DiagnosticInput, DiagnosticResult } from "./diagnostics.js";
import {
  ApplicationError,
  applicationError,
  isInfrastructureError,
  isNotFoundError,
  mapIntegrityReadError,
  mapLookupError,
  requireNonEmpty,
  requireSha256,
} from "./errors.js";
import { jsonObject, type ApplicationEvent, type ApplicationEventType } from "./events.js";
import type { ApplicationDependencies } from "./ports.js";

export interface CreateExperimentPlanInput {
  readonly evidenceStoreDir: string;
  readonly planId: string;
  readonly experimentId: string;
  readonly promptDefinition: PromptDefinition;
  readonly promptVersion: PromptVersion;
  readonly target: TargetRef;
  readonly testCases: readonly TestCase[];
  readonly repetitions: number;
  readonly timeoutMs?: number;
}

export interface CreateExperimentPlanResult {
  readonly planId: string;
  readonly planFingerprint: string;
  readonly plannedRunCount: number;
  readonly plannedRuns: ExperimentExecutionPlan["plannedRuns"];
  readonly plan: ExperimentExecutionPlan;
}

export interface StartExperimentInput {
  readonly evidenceStoreDir: string;
  readonly planFingerprint: string;
  readonly targetPath: string;
  readonly operationId?: string;
}

export interface ApplicationOperation {
  readonly id: string;
  readonly completion: Promise<ExperimentExecutionState>;
}

export interface BuildReportResult {
  readonly structured: ExperimentReport;
  readonly json: string;
  readonly markdown: string;
}

export interface ArtifactReadResult {
  readonly reference: string;
  readonly byteLength: number;
  readonly bytesBase64: string;
}

export interface ReviewRunInput {
  readonly evidenceStoreDir: string;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly status: HumanReviewStatus;
  readonly reviewer: string;
  readonly reviewedAt?: string;
  readonly comment?: string;
}

export interface ReadReviewInput {
  readonly evidenceStoreDir: string;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
}

export interface PromoteCaseInput extends Omit<PromoteGeneratedCaseInput, "store" | "now"> {
  readonly evidenceStoreDir: string;
}

export interface GenerateCasesApplicationInput extends Omit<GenerateCasesInput, "generator" | "now"> {}

interface ActiveOperation {
  readonly controller: AbortController;
  sequence: number;
}

export class LabApplication {
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private readonly now: () => Date;
  private readonly createOperationId: () => string;

  constructor(private readonly dependencies: ApplicationDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createOperationId = dependencies.createOperationId ?? (() => `operation-${crypto.randomUUID()}`);
  }

  activeOperationIds(): readonly string[] {
    return [...this.activeOperations.keys()];
  }

  private async emit(
    type: ApplicationEventType,
    payload: unknown,
    operationId?: string,
  ): Promise<ApplicationEvent> {
    const operation = operationId === undefined ? undefined : this.activeOperations.get(operationId);
    const event: ApplicationEvent = {
      type,
      ...(operationId === undefined ? {} : { operationId }),
      sequence: operation ? ++operation.sequence : 1,
      timestamp: this.now().toISOString(),
      payload: jsonObject(payload),
    };
    JSON.stringify(event);
    await this.dependencies.onEvent?.(event);
    return event;
  }

  async diagnose(input: DiagnosticInput): Promise<DiagnosticResult> {
    if (!this.dependencies.diagnostics) {
      throw new ApplicationError("CAPABILITY_UNAVAILABLE", "diagnostics provider is not configured");
    }
    try {
      const result = await this.dependencies.diagnostics.diagnose(input);
      await this.emit("diagnostics_completed", { ok: result.ok, checks: result.checks });
      return result;
    } catch (error) {
      throw applicationError(error, "INFRASTRUCTURE_FAILURE", "diagnostics failed");
    }
  }

  async discoverPrompts(input: {
    readonly playbookDir: string;
    readonly selector?: string;
  }): Promise<readonly DiscoveredPrompt[]> {
    const playbookDir = requireNonEmpty(input.playbookDir, "playbookDir");
    if (input.selector !== undefined) requireNonEmpty(input.selector, "selector");
    let prompts: readonly DiscoveredPrompt[];
    try {
      prompts = await (this.dependencies.promptDiscovery ?? discoverPrompts)(playbookDir);
    } catch (error) {
      throw mapLookupError(error, "prompt discovery failed");
    }
    try {
      return selectPrompts(prompts, input.selector);
    } catch (error) {
      throw applicationError(error, error instanceof TypeError ? "INVALID_ARGUMENT" : "NOT_FOUND", "prompt selector did not match");
    }
  }

  async discoverBenchmarks(input: {
    readonly playbookDir: string;
    readonly benchmarksDir: string;
    readonly selector?: string;
  }): Promise<readonly FixedBenchmarkDefinition[]> {
    const playbookDir = requireNonEmpty(input.playbookDir, "playbookDir");
    const benchmarksDir = requireNonEmpty(input.benchmarksDir, "benchmarksDir");
    if (input.selector !== undefined) requireNonEmpty(input.selector, "selector");
    let benchmarks: readonly FixedBenchmarkDefinition[];
    try {
      const prompts = await (this.dependencies.promptDiscovery ?? discoverPrompts)(playbookDir);
      benchmarks = await (this.dependencies.benchmarkDiscovery ?? discoverFixedBenchmarks)(benchmarksDir, prompts);
    } catch (error) {
      throw mapLookupError(error, "benchmark discovery failed");
    }
    try {
      return selectFixedBenchmarks(benchmarks, input.selector);
    } catch (error) {
      throw applicationError(error, error instanceof TypeError ? "INVALID_ARGUMENT" : "NOT_FOUND", "benchmark selector did not match");
    }
  }

  async createExperimentPlan(input: CreateExperimentPlanInput): Promise<CreateExperimentPlanResult> {
    try {
      const experiment = createExperiment({
        id: input.experimentId,
        promptDefinition: input.promptDefinition,
        promptVersion: input.promptVersion,
        target: input.target,
        testCases: input.testCases,
        configuration: {
          repetitions: input.repetitions,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        },
        runs: [],
      });
      const plan = createExperimentExecutionPlan({ id: input.planId, experiments: [experiment] });
      const store = await this.dependencies.openEvidenceStore(requireNonEmpty(input.evidenceStoreDir, "evidenceStoreDir"));
      await store.writePlan(plan);
      return {
        planId: plan.id,
        planFingerprint: plan.fingerprint,
        plannedRunCount: plan.plannedRuns.length,
        plannedRuns: plan.plannedRuns,
        plan,
      };
    } catch (error) {
      throw applicationError(error, error instanceof TypeError ? "INVALID_ARGUMENT" : "INFRASTRUCTURE_FAILURE", "experiment plan creation failed");
    }
  }

  async generateCases(input: GenerateCasesApplicationInput): Promise<GeneratedCasesResult> {
    if (!this.dependencies.exploratoryGenerator) {
      throw new ApplicationError("CAPABILITY_UNAVAILABLE", "exploratory case generator is not configured");
    }
    try {
      const result = await generateExploratoryCases({
        ...input,
        generator: this.dependencies.exploratoryGenerator,
        now: this.now,
      });
      await this.emit("cases_generated", {
        generationId: result.generationId,
        status: result.status,
        caseIds: result.cases.map(({ id }) => id),
      });
      return result;
    } catch (error) {
      throw applicationError(error, error instanceof TypeError ? "INVALID_ARGUMENT" : "INFRASTRUCTURE_FAILURE", "case generation failed");
    }
  }

  startExperiment(input: StartExperimentInput, resume = false): ApplicationOperation {
    requireNonEmpty(input.evidenceStoreDir, "evidenceStoreDir");
    requireSha256(input.planFingerprint, "planFingerprint");
    requireNonEmpty(input.targetPath, "targetPath");
    const id = input.operationId ?? this.createOperationId();
    requireNonEmpty(id, "operationId");
    if (!this.dependencies.executionBackendFactory || !this.dependencies.agentExecutor) {
      throw new ApplicationError("CAPABILITY_UNAVAILABLE", "V2 experiment execution provider is not configured");
    }
    if (this.activeOperations.has(id)) throw new ApplicationError("CONFLICT", `operation ${id} is already active`);
    const active: ActiveOperation = { controller: new AbortController(), sequence: 0 };
    this.activeOperations.set(id, active);
    const completion = this.executeExperiment(id, input, resume, active);
    return { id, completion };
  }

  resumeExperiment(input: StartExperimentInput): ApplicationOperation {
    return this.startExperiment(input, true);
  }

  private async executeExperiment(
    operationId: string,
    input: StartExperimentInput,
    resume: boolean,
    active: ActiveOperation,
  ): Promise<ExperimentExecutionState> {
    try {
      await this.emit("operation_started", { kind: resume ? "experiment_resume" : "experiment_run" }, operationId);
      const store = await this.dependencies.openEvidenceStore(input.evidenceStoreDir);
      const plan = await store.readPlan(input.planFingerprint);
      const backend = await this.dependencies.executionBackendFactory!({ plan, targetPath: input.targetPath });
      const state = await runStoredExperimentPlan({
        store,
        plan,
        backend,
        executor: this.dependencies.agentExecutor!,
        targetPath: input.targetPath,
        resume,
        signal: active.controller.signal,
        now: this.now,
        onEvent: async (event: ExperimentExecutionEvent) => {
          await this.emit("experiment_event", { event }, operationId);
        },
      });
      if (state.status === "interrupted") {
        await this.emit("operation_cancelled", { status: state.status, planFingerprint: state.planFingerprint }, operationId);
      } else {
        await this.emit("operation_completed", { status: state.status, planFingerprint: state.planFingerprint }, operationId);
      }
      return state;
    } catch (error) {
      const mapped = active.controller.signal.aborted
        ? new ApplicationError("CANCELLED", `operation ${operationId} was cancelled`, { cause: error })
        : isNotFoundError(error)
          ? applicationError(error, "NOT_FOUND", `operation ${operationId} plan was not found`)
          : error instanceof TypeError
            ? applicationError(error, "DATA_INTEGRITY_FAILURE", `operation ${operationId} source is invalid`)
            : applicationError(error, "INFRASTRUCTURE_FAILURE", `operation ${operationId} failed`);
      await this.emit("operation_failed", { code: mapped.code }, operationId);
      throw mapped;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  async cancelOperation(operationId: string): Promise<void> {
    const active = this.activeOperations.get(requireNonEmpty(operationId, "operationId"));
    if (!active) throw new ApplicationError("NOT_FOUND", `operation ${operationId} is not active`);
    active.controller.abort();
    await this.emit("operation_cancel_requested", {}, operationId);
  }

  private async store(root: string): Promise<FilesystemEvidenceStore> {
    try {
      return await this.dependencies.openEvidenceStore(requireNonEmpty(root, "evidenceStoreDir"));
    } catch (error) {
      throw applicationError(error, "INFRASTRUCTURE_FAILURE", "evidence store is unavailable");
    }
  }

  async buildReport(input: {
    readonly evidenceStoreDir: string;
    readonly planFingerprint: string;
  }): Promise<BuildReportResult> {
    requireSha256(input.planFingerprint, "planFingerprint");
    try {
      const structured = await buildExperimentReport({
        store: await this.store(input.evidenceStoreDir),
        planFingerprint: input.planFingerprint,
      });
      const result = {
        structured,
        json: serializeExperimentReportJson(structured),
        markdown: renderExperimentReportMarkdown(structured),
      };
      await this.emit("report_built", { planFingerprint: structured.plan.fingerprint, complete: structured.completeness.complete });
      return result;
    } catch (error) {
      throw mapIntegrityReadError(error, "report source is invalid or unavailable");
    }
  }

  async reviewRun(input: ReviewRunInput): Promise<HumanReviewAuditRecord> {
    requireSha256(input.planFingerprint, "planFingerprint");
    requireNonEmpty(input.plannedRunId, "plannedRunId");
    requireNonEmpty(input.reviewer, "reviewer");
    try {
      const record = await recordHumanReview({
        store: await this.store(input.evidenceStoreDir),
        planFingerprint: input.planFingerprint,
        plannedRunId: input.plannedRunId,
        status: input.status,
        reviewer: input.reviewer,
        ...(input.reviewedAt === undefined ? { now: this.now } : { reviewedAt: input.reviewedAt }),
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      });
      await this.emit("human_review_recorded", {
        planFingerprint: record.planFingerprint,
        plannedRunId: record.plannedRunId,
        sequence: record.sequence,
        status: record.status,
        recordFingerprint: record.recordFingerprint,
        sourceAttemptRef: record.sourceAttemptRef,
      });
      return record;
    } catch (error) {
      if (isInfrastructureError(error)) throw applicationError(error, "INFRASTRUCTURE_FAILURE", "human review failed");
      if (isNotFoundError(error) || error instanceof ReviewNotFoundError) throw applicationError(error, "NOT_FOUND", "human review source was not found");
      if (error instanceof ReviewConflictError) throw applicationError(error, "CONFLICT", "human review state is incompatible");
      if (error instanceof ReviewIntegrityError) throw applicationError(error, "DATA_INTEGRITY_FAILURE", "human review source is invalid");
      throw applicationError(error, error instanceof TypeError ? "INVALID_ARGUMENT" : "DATA_INTEGRITY_FAILURE", "human review failed");
    }
  }

  async readCurrentReview(input: ReadReviewInput): Promise<CurrentHumanReview> {
    requireSha256(input.planFingerprint, "planFingerprint");
    requireNonEmpty(input.plannedRunId, "plannedRunId");
    try {
      return await readCurrentHumanReview({ store: await this.store(input.evidenceStoreDir), ...input });
    } catch (error) {
      if (error instanceof ReviewNotFoundError) throw applicationError(error, "NOT_FOUND", "human review source was not found");
      if (error instanceof ReviewConflictError) throw applicationError(error, "CONFLICT", "human review state is incompatible");
      throw mapIntegrityReadError(error, "human review source is invalid");
    }
  }

  async readReviewHistory(input: ReadReviewInput): Promise<readonly HumanReviewAuditRecord[]> {
    requireSha256(input.planFingerprint, "planFingerprint");
    requireNonEmpty(input.plannedRunId, "plannedRunId");
    try {
      return await readHumanReviewHistory({ store: await this.store(input.evidenceStoreDir), ...input });
    } catch (error) {
      if (error instanceof ReviewNotFoundError) throw applicationError(error, "NOT_FOUND", "human review source was not found");
      if (error instanceof ReviewConflictError) throw applicationError(error, "CONFLICT", "human review state is incompatible");
      throw mapIntegrityReadError(error, "human review history is invalid");
    }
  }

  async promoteCase(input: PromoteCaseInput): Promise<PromotedGeneratedCaseResult> {
    requireSha256(input.planFingerprint, "planFingerprint");
    requireNonEmpty(input.plannedRunId, "plannedRunId");
    requireNonEmpty(input.benchmarksDir, "benchmarksDir");
    try {
      const result = await promoteGeneratedCase({
        store: await this.store(input.evidenceStoreDir),
        planFingerprint: input.planFingerprint,
        plannedRunId: input.plannedRunId,
        benchmarksDir: input.benchmarksDir,
        fixedCaseId: input.fixedCaseId,
        title: input.title,
        expectation: input.expectation,
        promotedBy: input.promotedBy,
        ...(input.promotedAt === undefined ? { now: this.now } : { promotedAt: input.promotedAt }),
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      });
      await this.emit("case_promoted", {
        planFingerprint: result.audit.source.planFingerprint,
        plannedRunId: result.audit.source.plannedRunId,
        fixedCaseId: result.audit.fixedCaseId,
        expectation: result.audit.expectation,
        auditFingerprint: result.audit.recordFingerprint,
        benchmarkPath: result.audit.benchmarkPath,
        metadataPath: result.audit.metadataPath,
      });
      return result;
    } catch (error) {
      if (isInfrastructureError(error)) throw applicationError(error, "INFRASTRUCTURE_FAILURE", "case promotion failed");
      if (error instanceof ReviewNotFoundError) throw applicationError(error, "NOT_FOUND", "promotion source was not found");
      if (error instanceof PromotionConflictError || error instanceof ReviewConflictError) throw applicationError(error, "CONFLICT", "case promotion state is incompatible");
      if (error instanceof PromotionIntegrityError || error instanceof ReviewIntegrityError) throw applicationError(error, "DATA_INTEGRITY_FAILURE", "case promotion source is invalid");
      if (isNotFoundError(error) || error instanceof TypeError) throw applicationError(error, "INVALID_ARGUMENT", "case promotion input is invalid");
      throw applicationError(error, "INTERNAL_ERROR", "case promotion failed");
    }
  }

  async readArtifact(input: {
    readonly evidenceStoreDir: string;
    readonly reference: ArtifactReference | string;
  }): Promise<ArtifactReadResult> {
    try {
      const bytes = await (await this.store(input.evidenceStoreDir)).readArtifact(input.reference);
      return {
        reference: typeof input.reference === "string" ? input.reference : input.reference.ref,
        byteLength: bytes.byteLength,
        bytesBase64: bytes.toString("base64"),
      };
    } catch (error) {
      const code = error instanceof TypeError
        ? "INVALID_ARGUMENT"
        : isInfrastructureError(error)
          ? "INFRASTRUCTURE_FAILURE"
          : isNotFoundError(error)
            ? "NOT_FOUND"
            : "DATA_INTEGRITY_FAILURE";
      throw applicationError(error, code, "artifact could not be read");
    }
  }
}

export function createLabApplication(dependencies: ApplicationDependencies): LabApplication {
  return new LabApplication(dependencies);
}

export type { PromotionExpectation };
