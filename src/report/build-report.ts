import {
  HUMAN_REVIEW_STATUSES,
  TECHNICAL_STATUSES,
  createExperimentRun,
  type HumanReviewStatus,
  type TechnicalStatus,
} from "../domain/index.js";
import type { FilesystemEvidenceStore } from "../evidence/index.js";
import {
  canonicalJson,
  findPlannedRunContext,
  sha256Canonical,
  validateExperimentExecutionState,
  type ExperimentExecutionPlan,
  type LogicalRunState,
  type PlannedRun,
} from "../experiment/index.js";
import { humanReviewRecordRef, readHumanReviewHistory } from "../review/index.js";
import {
  EXPERIMENT_REPORT_FORMAT,
  EXPERIMENT_REPORT_VERSION,
  type ExperimentReport,
  type ExperimentReportComparison,
  type ExperimentReportRun,
  type ReportCompletenessReason,
  type ReportCountSources,
  type ReportEvidenceTypeSummary,
  type ReportMetricSummary,
} from "./schema.js";

export interface BuildExperimentReportInput {
  readonly store: FilesystemEvidenceStore;
  readonly planFingerprint: string;
}

const TERMINAL = new Set<TechnicalStatus>(["completed", "failed"]);

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function initialLogicalRun(plannedRun: PlannedRun): LogicalRunState {
  return {
    plannedRunId: plannedRun.id,
    experimentId: plannedRun.experimentId,
    testCaseId: plannedRun.testCaseId,
    promptVersionId: plannedRun.promptVersionId,
    variant: plannedRun.variant,
    repetition: plannedRun.repetition,
    caseInputFingerprint: plannedRun.caseInputFingerprint,
    attempt: 0,
    run: createExperimentRun({
      id: plannedRun.id,
      experimentId: plannedRun.experimentId,
      testCaseId: plannedRun.testCaseId,
    }),
  };
}

function checkpointRef(planFingerprint: string, sequence: number): string {
  return `plans/${planFingerprint}/checkpoints/${String(sequence).padStart(8, "0")}.json`;
}

function countSources(ids: readonly string[]): ReportCountSources {
  return { count: ids.length, plannedRunIds: ids };
}

function evidenceTypeCounts(run: ExperimentReportRun): readonly { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const evidence of run.evidence ?? []) counts.set(evidence.type, (counts.get(evidence.type) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => lexical(left, right)).map(([type, count]) => ({ type, count }));
}

function endpoint(run: ExperimentReportRun): ExperimentReportComparison["baseline"] {
  return {
    plannedRunId: run.plannedRunId,
    technicalStatus: run.technicalStatus,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    evidenceTypeCounts: evidenceTypeCounts(run),
  };
}

function difference(left: readonly string[], right: ReadonlySet<string>): readonly string[] {
  return [...new Set(left)].filter((value) => !right.has(value)).sort(lexical);
}

function comparison(baseline: ExperimentReportRun, treatment: ExperimentReportRun): ExperimentReportComparison {
  const missingFacts: string[] = [];
  if (!baseline.manifest) missingFacts.push("baseline.manifest");
  if (!treatment.manifest) missingFacts.push("treatment.manifest");
  if (baseline.exitCode === undefined) missingFacts.push("baseline.exitCode");
  if (treatment.exitCode === undefined) missingFacts.push("treatment.exitCode");
  if (baseline.durationMs === undefined) missingFacts.push("baseline.durationMs");
  if (treatment.durationMs === undefined) missingFacts.push("treatment.durationMs");
  if (baseline.changedFiles === undefined) missingFacts.push("baseline.changedFiles");
  if (treatment.changedFiles === undefined) missingFacts.push("treatment.changedFiles");
  if (!baseline.manifest?.artifacts.finalOutput) missingFacts.push("baseline.finalOutput");
  if (!treatment.manifest?.artifacts.finalOutput) missingFacts.push("treatment.finalOutput");
  const bothDurations = baseline.durationMs !== undefined && treatment.durationMs !== undefined;
  const bothChangedFiles = baseline.changedFiles !== undefined && treatment.changedFiles !== undefined;
  const baselineFiles = new Set(baseline.changedFiles ?? []);
  const treatmentFiles = new Set(treatment.changedFiles ?? []);
  const bothManifests = baseline.manifest !== null && treatment.manifest !== null;
  const bothOutputs = baseline.manifest?.artifacts.finalOutput && treatment.manifest?.artifacts.finalOutput;
  return {
    experimentId: baseline.experimentId,
    testCaseId: baseline.testCase.id,
    repetition: baseline.repetition,
    comparisonComplete: bothManifests && TERMINAL.has(baseline.technicalStatus) && TERMINAL.has(treatment.technicalStatus),
    missingFacts,
    baseline: endpoint(baseline),
    treatment: endpoint(treatment),
    ...(bothDurations ? { treatmentMinusBaselineMs: treatment.durationMs! - baseline.durationMs! } : {}),
    ...(bothChangedFiles ? {
      changedFiles: {
        shared: [...baselineFiles].filter((value) => treatmentFiles.has(value)).sort(lexical),
        baselineOnly: difference([...baselineFiles], treatmentFiles),
        treatmentOnly: difference([...treatmentFiles], baselineFiles),
      },
    } : {}),
    ...(bothManifests ? {
      fingerprints: {
        sameTestCaseFingerprint: baseline.manifest!.fingerprints.testCase === treatment.manifest!.fingerprints.testCase,
        sameTargetFingerprint: baseline.manifest!.fingerprints.target === treatment.manifest!.fingerprints.target,
        sameRunnerFingerprint: baseline.manifest!.fingerprints.runner === treatment.manifest!.fingerprints.runner,
        sameConfigurationFingerprint:
          baseline.manifest!.fingerprints.configuration === treatment.manifest!.fingerprints.configuration,
      },
    } : {}),
    ...(bothOutputs ? {
      artifacts: {
        sameFinalOutputSha256: baseline.manifest!.artifacts.finalOutput!.sha256
          === treatment.manifest!.artifacts.finalOutput!.sha256,
      },
    } : {}),
  };
}

function buildEvidenceSummary(runs: readonly ExperimentReportRun[]): {
  readonly evidenceTypes: readonly ReportEvidenceTypeSummary[];
  readonly metrics: readonly ReportMetricSummary[];
} {
  const evidence = new Map<string, ReportEvidenceTypeSummary["sources"] extends readonly (infer T)[] ? T[] : never>();
  const metrics = new Map<string, {
    name: string;
    unit: string | null;
    observations: Array<{ plannedRunId: string; evidenceIndex: number; value: number; manifestRef: string }>;
  }>();
  for (const run of runs) {
    if (!run.manifest || !run.evidence) continue;
    run.evidence.forEach((entry, evidenceIndex) => {
      const sources = evidence.get(entry.type) ?? [];
      sources.push({ plannedRunId: run.plannedRunId, evidenceIndex, manifestRef: run.manifest!.ref });
      evidence.set(entry.type, sources);
      if (!entry.metric) return;
      const unit = entry.metric.unit ?? null;
      const key = `${entry.metric.name}\u0000${unit ?? ""}`;
      const metric = metrics.get(key) ?? { name: entry.metric.name, unit, observations: [] };
      metric.observations.push({
        plannedRunId: run.plannedRunId,
        evidenceIndex,
        value: entry.metric.value,
        manifestRef: run.manifest!.ref,
      });
      metrics.set(key, metric);
    });
  }
  return {
    evidenceTypes: [...evidence.entries()].sort(([left], [right]) => lexical(left, right)).map(([type, sources]) => ({
      type,
      count: sources.length,
      sources,
    })),
    metrics: [...metrics.values()].sort((left, right) => lexical(
      `${left.name}\u0000${left.unit ?? ""}`,
      `${right.name}\u0000${right.unit ?? ""}`,
    )).map(({ name, unit, observations }) => {
      const values = observations.map(({ value }) => value);
      return {
        name,
        unit,
        observationCount: observations.length,
        sum: values.reduce((total, value) => total + value, 0),
        min: Math.min(...values),
        max: Math.max(...values),
        observations,
      };
    }),
  };
}

function completenessReasons(input: {
  readonly hasCheckpoint: boolean;
  readonly executionStatus?: string;
  readonly runs: readonly ExperimentReportRun[];
}): readonly ReportCompletenessReason[] {
  const reasons: ReportCompletenessReason[] = [];
  if (!input.hasCheckpoint) reasons.push("no_checkpoint");
  if (input.executionStatus === "pending") reasons.push("execution_pending");
  if (input.executionStatus === "running") reasons.push("execution_running");
  if (input.executionStatus === "interrupted") reasons.push("execution_interrupted");
  if (input.runs.some(({ technicalStatus }) => !TERMINAL.has(technicalStatus))) reasons.push("non_terminal_runs");
  if (input.runs.some(({ attempts }) => attempts.some(({ status }) => status === "partial"))) reasons.push("partial_attempts");
  if (input.runs.some((run) => (
    !TERMINAL.has(run.technicalStatus)
    && run.attempt > 0
    && run.attempts.some(({ attempt, status }) => attempt === run.attempt && status === "finalized")
  ))) reasons.push("finalized_attempt_ahead_of_checkpoint");
  return reasons;
}

async function buildRun(
  store: FilesystemEvidenceStore,
  plan: ExperimentExecutionPlan,
  plannedRun: PlannedRun,
  logicalRun: LogicalRunState,
): Promise<ExperimentReportRun> {
  const { testCase } = findPlannedRunContext(plan, plannedRun);
  const storedAttempts = await store.listRunAttempts(plan.fingerprint, plannedRun.id);
  const attempts = await Promise.all([...storedAttempts].sort((left, right) => left.attempt - right.attempt).map(async (summary) => {
    const stored = await store.readAttempt(plan.fingerprint, plannedRun.id, summary.attempt);
    return {
      ...summary,
      startedFingerprint: sha256Canonical(stored.started),
      manifestFingerprint: stored.manifest ? sha256Canonical(stored.manifest) : null,
      modelInput: stored.started.modelInput,
    };
  }));
  const terminal = TERMINAL.has(logicalRun.run.technicalStatus);
  const currentAttempt = logicalRun.attempt === 0
    ? null
    : await store.listRunAttempts(plan.fingerprint, plannedRun.id).then((items) => (
      items.find(({ attempt }) => attempt === logicalRun.attempt) ?? null
    ));
  if (terminal && (!currentAttempt || currentAttempt.status !== "finalized")) {
    throw new Error(`terminal run ${plannedRun.id} lacks its finalized current manifest`);
  }
  const storedCurrent = currentAttempt?.status === "finalized"
    ? await store.readAttempt(plan.fingerprint, plannedRun.id, logicalRun.attempt)
    : null;
  const manifest = terminal ? storedCurrent?.manifest ?? null : null;
  if (manifest && canonicalJson(manifest.experimentRun) !== canonicalJson(logicalRun.run)) {
    throw new Error(`terminal run ${plannedRun.id} differs from its finalized current manifest`);
  }
  const history = terminal
    ? await readHumanReviewHistory({ store, planFingerprint: plan.fingerprint, plannedRunId: plannedRun.id })
    : [];
  const reviewActions = history.map((record) => ({
    sequence: record.sequence,
    previousStatus: record.previousStatus,
    status: record.status,
    reviewer: record.reviewer,
    reviewedAt: record.reviewedAt,
    ...(record.comment === undefined ? {} : { comment: record.comment }),
    sourceRef: humanReviewRecordRef(plan.fingerprint, plannedRun.id, record.sequence),
    recordFingerprint: record.recordFingerprint,
    sourceAttemptRef: record.sourceAttemptRef,
    sourceAttemptFingerprint: record.sourceAttemptFingerprint,
  }));
  const latestReview = reviewActions.at(-1);
  const workspaceKnown = manifest?.workspace !== null && manifest?.workspace !== undefined;
  return {
    plannedRunId: plannedRun.id,
    ordinal: plannedRun.ordinal,
    experimentId: plannedRun.experimentId,
    promptVersionId: plannedRun.promptVersionId,
    testCase: {
      id: testCase.id,
      title: testCase.title,
      kind: testCase.kind,
      inputFingerprint: plannedRun.caseInputFingerprint,
    },
    variant: plannedRun.variant,
    repetition: plannedRun.repetition,
    attempt: logicalRun.attempt,
    technicalStatus: logicalRun.run.technicalStatus,
    ...(manifest?.exitCode === null || manifest?.exitCode === undefined ? {} : { exitCode: manifest.exitCode }),
    ...(manifest?.durationMs === null || manifest?.durationMs === undefined ? {} : { durationMs: manifest.durationMs }),
    ...(workspaceKnown ? { changedFiles: [...manifest!.changedFiles].sort(lexical) } : {}),
    ...(manifest ? { evidence: manifest.evidence } : {}),
    attempts,
    manifest: manifest && currentAttempt?.manifestRef ? {
      ref: currentAttempt.manifestRef,
      fingerprint: sha256Canonical(manifest),
      termination: manifest.termination,
      fingerprints: manifest.fingerprints,
      artifacts: manifest.artifacts,
      workspaceKnown,
    } : null,
    humanReview: latestReview ? {
      status: latestReview.status,
      origin: "human_action",
      reviewer: latestReview.reviewer,
      reviewedAt: latestReview.reviewedAt,
      ...(latestReview.comment === undefined ? {} : { comment: latestReview.comment }),
      sequence: latestReview.sequence,
      sourceRef: latestReview.sourceRef,
      recordFingerprint: latestReview.recordFingerprint,
      history: reviewActions,
    } : {
      status: "pending_review",
      origin: "default_pending",
      history: [],
    },
  };
}

export async function buildExperimentReport(input: BuildExperimentReportInput): Promise<ExperimentReport> {
  const plan = await input.store.readPlan(input.planFingerprint);
  const latest = await input.store.readLatestCheckpoint(plan.fingerprint);
  if (latest.invalidCheckpointRefs.length > 0) {
    throw new Error(`experiment report refuses invalid checkpoints: ${latest.invalidCheckpointRefs.join(", ")}`);
  }
  if (latest.checkpoint) validateExperimentExecutionState(plan, latest.checkpoint.state);
  const logicalRuns = latest.checkpoint?.state.runs
    ?? plan.plannedRuns.map(initialLogicalRun);
  const runs = await Promise.all(plan.plannedRuns.map((plannedRun, index) => (
    buildRun(input.store, plan, plannedRun, logicalRuns[index]!)
  )));
  const technicalStatuses = Object.fromEntries(TECHNICAL_STATUSES.map((status) => [
    status,
    countSources(runs.filter((run) => run.technicalStatus === status).map(({ plannedRunId }) => plannedRunId)),
  ])) as Record<TechnicalStatus, ReportCountSources>;
  const humanReviewStatuses = Object.fromEntries(HUMAN_REVIEW_STATUSES.map((status) => [
    status,
    countSources(runs.filter((run) => run.humanReview.status === status).map(({ plannedRunId }) => plannedRunId)),
  ])) as Record<HumanReviewStatus, ReportCountSources>;
  const durationObservations = runs.flatMap((run) => (
    run.durationMs === undefined || !run.manifest ? [] : [{
      plannedRunId: run.plannedRunId,
      durationMs: run.durationMs,
      sourceManifestRef: run.manifest.ref,
    }]
  ));
  const knownChangedRuns = runs.filter((run) => run.changedFiles !== undefined && run.manifest !== null);
  const changedRunIds = knownChangedRuns.filter((run) => run.changedFiles!.length > 0).map(({ plannedRunId }) => plannedRunId);
  const unchangedRunIds = knownChangedRuns.filter((run) => run.changedFiles!.length === 0).map(({ plannedRunId }) => plannedRunId);
  const changedPaths = [...new Set(knownChangedRuns.flatMap(({ changedFiles }) => changedFiles ?? []))].sort(lexical);
  const evidenceSummary = buildEvidenceSummary(runs);
  const reviewSources = runs.flatMap((run) => run.humanReview.history.map((action) => ({
    plannedRunId: run.plannedRunId,
    sequence: action.sequence,
    sourceRef: action.sourceRef,
    recordFingerprint: action.recordFingerprint,
  })));
  const byId = new Map(runs.map((run) => [run.plannedRunId, run]));
  const comparisons = plan.plannedRuns.filter(({ variant }) => variant === "baseline").map((baselinePlan) => {
    const treatmentPlan = plan.plannedRuns.find((candidate) => (
      candidate.experimentId === baselinePlan.experimentId
      && candidate.testCaseId === baselinePlan.testCaseId
      && candidate.repetition === baselinePlan.repetition
      && candidate.variant === "treatment"
    ));
    if (!treatmentPlan) throw new Error(`missing treatment PlannedRun for ${baselinePlan.id}`);
    return comparison(byId.get(baselinePlan.id)!, byId.get(treatmentPlan.id)!);
  });
  const reasons = completenessReasons({
    hasCheckpoint: latest.checkpoint !== null,
    executionStatus: latest.checkpoint?.state.status,
    runs,
  });
  const report: ExperimentReport = {
    format: EXPERIMENT_REPORT_FORMAT,
    version: EXPERIMENT_REPORT_VERSION,
    plan: {
      id: plan.id,
      fingerprint: plan.fingerprint,
      plannedRunCount: plan.plannedRuns.length,
      target: plan.target,
    },
    source: {
      planRef: `plans/${plan.fingerprint}/plan.json`,
      checkpoint: latest.checkpoint ? {
        ref: checkpointRef(plan.fingerprint, latest.checkpoint.sequence),
        sequence: latest.checkpoint.sequence,
        stateFingerprint: latest.checkpoint.stateFingerprint,
        executionStatus: latest.checkpoint.state.status,
      } : null,
    },
    completeness: { complete: reasons.length === 0, reasons },
    summary: {
      technicalStatuses,
      humanReviewStatuses,
      pendingReviewRunIds: humanReviewStatuses.pending_review.plannedRunIds,
      reviewActions: { count: reviewSources.length, sources: reviewSources },
      durations: {
        knownRunCount: durationObservations.length,
        totalMs: durationObservations.length === 0
          ? null
          : durationObservations.reduce((total, observation) => total + observation.durationMs, 0),
        observations: durationObservations,
      },
      changedFiles: {
        knownRunCount: knownChangedRuns.length,
        runsWithChanges: countSources(changedRunIds),
        runsWithoutChanges: countSources(unchangedRunIds),
        union: changedPaths.map((changedPath) => {
          const sources = knownChangedRuns.filter(({ changedFiles }) => changedFiles!.includes(changedPath));
          return {
            path: changedPath,
            plannedRunIds: sources.map(({ plannedRunId }) => plannedRunId),
            sourceManifestRefs: sources.map(({ manifest }) => manifest!.ref),
          };
        }),
      },
      ...evidenceSummary,
    },
    runs,
    comparisons,
  };
  input.store.assertPortable(report);
  return report;
}
