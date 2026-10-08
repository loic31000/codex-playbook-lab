import {
  createEvidence,
  createExperimentRun,
  createTargetRef,
  parseExperimentRun,
  updateRunTechnicalState,
  type ExperimentRun,
} from "../domain/index.js";
import { canonicalJson } from "./canonical-json.js";
import {
  LocalRunExecutionError,
  type ExecutionAttemptFacts,
  type ExecutionBaseline,
  type ExperimentAgentExecutor,
  type ExperimentExecutionBackend,
} from "./execution-backend.js";
import type { ExperimentExecutionEvent, ExperimentExecutionEventType } from "./events.js";
import { buildExperimentModelInput } from "./model-input.js";
import { findPlannedRunContext, type ExperimentExecutionPlan, type PlannedRun } from "./plan.js";

export type ExperimentExecutionStatus =
  | "pending"
  | "running"
  | "interrupted"
  | "completed"
  | "completed_with_failures";

export interface LogicalRunState {
  readonly plannedRunId: string;
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly promptVersionId: string;
  readonly variant: PlannedRun["variant"];
  readonly repetition: number;
  readonly caseInputFingerprint: string;
  readonly attempt: number;
  readonly run: ExperimentRun;
  readonly facts?: ExecutionAttemptFacts;
}

export interface ExperimentExecutionState {
  readonly planId: string;
  readonly planFingerprint: string;
  readonly status: ExperimentExecutionStatus;
  readonly baseline?: ExecutionBaseline;
  readonly runs: readonly LogicalRunState[];
  readonly events: readonly ExperimentExecutionEvent[];
}

export interface RunExperimentPlanInput {
  readonly plan: ExperimentExecutionPlan;
  readonly backend: ExperimentExecutionBackend;
  readonly targetPath: string;
  readonly executor: ExperimentAgentExecutor;
  readonly previousState?: ExperimentExecutionState;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly onEvent?: (event: ExperimentExecutionEvent) => void | Promise<void>;
  readonly onCheckpoint?: (state: ExperimentExecutionState) => void | Promise<void>;
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

function clonePreviousState(state: ExperimentExecutionState): ExperimentExecutionState {
  return JSON.parse(JSON.stringify(state)) as ExperimentExecutionState;
}

const EXECUTION_STATUSES: readonly ExperimentExecutionStatus[] = [
  "pending",
  "running",
  "interrupted",
  "completed",
  "completed_with_failures",
];

const RUN_EVENT_TYPES: readonly ExperimentExecutionEventType[] = [
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_skipped",
];

const PLAN_EVENT_TYPES: readonly ExperimentExecutionEventType[] = [
  "plan_started",
  "plan_resumed",
  "plan_interrupted",
  "plan_completed",
  "plan_completed_with_failures",
];

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function assertNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
}

function assertNullableNonEmptyString(value: unknown, path: string): void {
  if (value === null) return;
  assertNonEmptyString(value, path);
}

function assertNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
}

function validateResumeBaseline(plan: ExperimentExecutionPlan, state: ExperimentExecutionState): void {
  const hasStarted = state.status !== "pending"
    || state.events.length > 0
    || state.runs.some(({ attempt, run }) => attempt > 0 || run.technicalStatus !== "pending");
  if (hasStarted && state.baseline === undefined) {
    throw new Error("a previous orchestration state that has started requires an execution baseline");
  }
  if (state.baseline === undefined) return;
  const target = createTargetRef(state.baseline.target);
  if (canonicalJson(target) !== canonicalJson(plan.target)) {
    throw new Error("previous orchestration state baseline target differs from the execution plan target");
  }
  assertNonEmptyString(state.baseline.workspaceFingerprint, "previousState.baseline.workspaceFingerprint");
  assertNullableNonEmptyString(state.baseline.gitHead, "previousState.baseline.gitHead");
  assertNullableNonEmptyString(state.baseline.gitTree, "previousState.baseline.gitTree");
  assertNullableString(state.baseline.gitStatus, "previousState.baseline.gitStatus");
  assertNonEmptyString(state.baseline.image, "previousState.baseline.image");
  assertNonEmptyString(state.baseline.policyFingerprint, "previousState.baseline.policyFingerprint");
}

function validateHistoricalEvents(plan: ExperimentExecutionPlan, state: ExperimentExecutionState): void {
  const plannedRuns = new Map(plan.plannedRuns.map((plannedRun) => [plannedRun.id, plannedRun]));
  const logicalRuns = new Map(state.runs.map((logicalRun) => [logicalRun.plannedRunId, logicalRun]));
  for (let index = 0; index < state.events.length; index += 1) {
    const event = state.events[index]!;
    if (event.sequence !== index + 1) throw new Error("previous event sequence is not monotone");
    if (event.planId !== plan.id) throw new Error(`previous event ${index + 1} references another plan id`);
    if (event.planFingerprint !== plan.fingerprint) {
      throw new Error(`previous event ${index + 1} references another plan fingerprint`);
    }
    if (!isIsoTimestamp(event.timestamp)) throw new TypeError(`previous event ${index + 1} timestamp is not ISO-8601`);
    if (![...PLAN_EVENT_TYPES, ...RUN_EVENT_TYPES].includes(event.type)) {
      throw new TypeError(`previous event ${index + 1} has an unknown type`);
    }
    if (!RUN_EVENT_TYPES.includes(event.type)) continue;
    const runEvent = event as Extract<ExperimentExecutionEvent, { plannedRunId: string }>;
    const plannedRun = plannedRuns.get(runEvent.plannedRunId);
    if (!plannedRun) throw new Error(`previous run event references unknown PlannedRun ${runEvent.plannedRunId}`);
    const logicalRun = logicalRuns.get(runEvent.plannedRunId);
    if (!logicalRun) throw new Error(`previous run event has no logical run ${runEvent.plannedRunId}`);
    if (
      runEvent.experimentId !== plannedRun.experimentId
      || runEvent.testCaseId !== plannedRun.testCaseId
      || runEvent.variant !== plannedRun.variant
      || runEvent.repetition !== plannedRun.repetition
    ) {
      throw new Error(`previous run event differs from PlannedRun ${plannedRun.id}`);
    }
    if (!Number.isInteger(runEvent.attempt) || runEvent.attempt < 1) {
      throw new TypeError(`previous run event ${runEvent.sequence} attempt must be a positive integer`);
    }
    if (runEvent.type === "run_skipped" && runEvent.attempt !== logicalRun.attempt) {
      throw new Error(`previous skipped event attempt differs from logical run ${plannedRun.id}`);
    }
    if (runEvent.attempt > logicalRun.attempt) {
      throw new Error(`previous run event attempt exceeds logical run ${plannedRun.id} attempt`);
    }
  }
  const terminalEventByStatus = {
    running: "run_started",
    completed: "run_completed",
    failed: "run_failed",
    cancelled: "run_cancelled",
  } as const;
  for (const logicalRun of state.runs) {
    const lifecycleEvents = state.events.filter((event): event is Extract<ExperimentExecutionEvent, { plannedRunId: string }> => (
      RUN_EVENT_TYPES.includes(event.type)
      && event.type !== "run_skipped"
      && (event as Extract<ExperimentExecutionEvent, { plannedRunId: string }>).plannedRunId === logicalRun.plannedRunId
    ));
    if (logicalRun.run.technicalStatus === "pending") {
      if (lifecycleEvents.length !== 0) {
        throw new Error(`previous pending run ${logicalRun.plannedRunId} has execution events`);
      }
      continue;
    }
    const latest = lifecycleEvents.at(-1);
    const expectedType = terminalEventByStatus[logicalRun.run.technicalStatus];
    if (latest?.type !== expectedType || latest.attempt !== logicalRun.attempt) {
      throw new Error(`previous run history differs from logical run ${logicalRun.plannedRunId}`);
    }
  }
}

export function validateExperimentExecutionState(
  plan: ExperimentExecutionPlan,
  state: ExperimentExecutionState,
): void {
  if (state.planId !== plan.id || state.planFingerprint !== plan.fingerprint) {
    throw new Error("previous orchestration state plan fingerprint does not match the execution plan");
  }
  if (!EXECUTION_STATUSES.includes(state.status)) {
    throw new TypeError(`previous orchestration state has an unknown status: ${String(state.status)}`);
  }
  if (!Array.isArray(state.runs) || !Array.isArray(state.events)) {
    throw new TypeError("previous orchestration state runs and events must be arrays");
  }
  if (state.runs.length !== plan.plannedRuns.length) {
    throw new Error("previous orchestration state logical run count differs from the execution plan");
  }
  for (let index = 0; index < plan.plannedRuns.length; index += 1) {
    const planned = plan.plannedRuns[index]!;
    const existing = state.runs[index]!;
    if (
      existing.plannedRunId !== planned.id
      || existing.experimentId !== planned.experimentId
      || existing.testCaseId !== planned.testCaseId
      || existing.caseInputFingerprint !== planned.caseInputFingerprint
      || existing.promptVersionId !== planned.promptVersionId
      || existing.variant !== planned.variant
      || existing.repetition !== planned.repetition
    ) {
      throw new Error(`previous orchestration state differs at PlannedRun ${planned.id}`);
    }
    if (!Number.isInteger(existing.attempt) || existing.attempt < 0) {
      throw new TypeError(`previous logical run ${planned.id} attempt must be a non-negative integer`);
    }
    const validatedRun = parseExperimentRun(existing.run);
    if (
      validatedRun.id !== planned.id
      || validatedRun.experimentId !== planned.experimentId
      || validatedRun.testCaseId !== planned.testCaseId
    ) {
      throw new Error(`previous ExperimentRun differs from PlannedRun ${planned.id}`);
    }
    if (validatedRun.technicalStatus === "pending" && existing.attempt !== 0) {
      throw new Error(`previous pending run ${planned.id} must have attempt 0`);
    }
    if (validatedRun.technicalStatus !== "pending" && existing.attempt < 1) {
      throw new Error(`previous ${validatedRun.technicalStatus} run ${planned.id} must have an attempt`);
    }
  }
  validateResumeBaseline(plan, state);
  validateHistoricalEvents(plan, state);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortError(): Error {
  return Object.assign(new Error("operation aborted"), { name: "AbortError" });
}

function baselineEqual(left: ExecutionBaseline, right: ExecutionBaseline): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function runExperimentPlan(input: RunExperimentPlanInput): Promise<ExperimentExecutionState> {
  if (typeof input.targetPath !== "string" || input.targetPath.trim() === "") {
    throw new TypeError("targetPath must be explicitly provided");
  }
  if (input.previousState) validateExperimentExecutionState(input.plan, input.previousState);
  const previous = input.previousState ? clonePreviousState(input.previousState) : undefined;
  const runs = previous
    ? [...previous.runs]
    : input.plan.plannedRuns.map(initialLogicalRun);
  const events = previous ? [...previous.events] : [];
  const now = input.now ?? (() => new Date());
  let status: ExperimentExecutionStatus = "running";
  let baseline = previous?.baseline;

  const stateSnapshot = (): ExperimentExecutionState => clonePreviousState({
    planId: input.plan.id,
    planFingerprint: input.plan.fingerprint,
    status,
    ...(baseline === undefined ? {} : { baseline }),
    runs,
    events,
  });

  const checkpoint = async (): Promise<void> => {
    if (input.onCheckpoint) await input.onCheckpoint(stateSnapshot());
  };

  const emit = async (type: ExperimentExecutionEventType, plannedRun?: PlannedRun, attempt = 0): Promise<ExperimentExecutionEvent> => {
    const common = {
      type,
      sequence: events.length + 1,
      planId: input.plan.id,
      planFingerprint: input.plan.fingerprint,
      timestamp: now().toISOString(),
    } as const;
    const event = plannedRun
      ? {
          ...common,
          type: type as "run_started" | "run_completed" | "run_failed" | "run_cancelled" | "run_skipped",
          plannedRunId: plannedRun.id,
          experimentId: plannedRun.experimentId,
          testCaseId: plannedRun.testCaseId,
          variant: plannedRun.variant,
          repetition: plannedRun.repetition,
          attempt,
        }
      : common as ExperimentExecutionEvent;
    events.push(event);
    await input.onEvent?.(event);
    return event;
  };

  await emit(previous ? "plan_resumed" : "plan_started");
  const session = await input.backend.open({
    target: input.plan.target,
    targetPath: input.targetPath,
    ...(baseline === undefined ? {} : { expectedBaseline: baseline }),
    signal: input.signal,
  });
  try {
    if (baseline && !baselineEqual(session.baseline, baseline)) {
      throw new Error("execution baseline differs from previous orchestration state");
    }
    baseline = session.baseline;
    await checkpoint();
    for (let index = 0; index < input.plan.plannedRuns.length; index += 1) {
      const plannedRun = input.plan.plannedRuns[index]!;
      const existing = runs[index]!;
      if (existing.run.technicalStatus === "completed" || existing.run.technicalStatus === "failed") {
        await emit("run_skipped", plannedRun, existing.attempt);
        continue;
      }
      if (input.signal?.aborted) {
        status = "interrupted";
        await emit("plan_interrupted");
        await checkpoint();
        break;
      }
      const attempt = existing.attempt + 1;
      const startedEvent = await emit("run_started", plannedRun, attempt);
      const running = createExperimentRun({
        id: plannedRun.id,
        experimentId: plannedRun.experimentId,
        testCaseId: plannedRun.testCaseId,
        technicalStatus: "running",
        startedAt: startedEvent.timestamp,
      });
      runs[index] = { ...existing, attempt, run: running, facts: undefined };
      await checkpoint();
      const { experiment, testCase } = findPlannedRunContext(input.plan, plannedRun);
      const modelInput = buildExperimentModelInput({
        variant: plannedRun.variant,
        promptVersion: experiment.promptVersion,
        testCase,
      });
      try {
        const result = await session.executeRun({
          plannedRun,
          experiment,
          testCase,
          modelInput,
          attempt,
          startedAt: startedEvent.timestamp,
          executor: input.executor,
          signal: input.signal,
        });
        if (input.signal?.aborted) throw abortError();
        const technicalStatus = result.exitCode === 0 ? "completed" : "failed";
        const finishedEvent = await emit(technicalStatus === "completed" ? "run_completed" : "run_failed", plannedRun, attempt);
        runs[index] = {
          ...runs[index]!,
          facts: result.facts,
          run: updateRunTechnicalState(running, {
            technicalStatus,
            finishedAt: finishedEvent.timestamp,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            changedFiles: result.changedFiles,
            evidence: result.evidence,
          }),
        };
        await checkpoint();
      } catch (error) {
        if (isAbort(error, input.signal)) {
          const cancelledEvent = await emit("run_cancelled", plannedRun, attempt);
          runs[index] = {
            ...runs[index]!,
            run: updateRunTechnicalState(running, {
              technicalStatus: "cancelled",
              finishedAt: cancelledEvent.timestamp,
            }),
          };
          await checkpoint();
          status = "interrupted";
          await emit("plan_interrupted");
          await checkpoint();
          break;
        }
        if (!(error instanceof LocalRunExecutionError)) throw error;
        const failedEvent = await emit("run_failed", plannedRun, attempt);
        runs[index] = {
          ...runs[index]!,
          run: updateRunTechnicalState(running, {
            technicalStatus: "failed",
            finishedAt: failedEvent.timestamp,
            evidence: [createEvidence({
              type: "execution-error",
              recordedAt: failedEvent.timestamp,
              source: "experiment-orchestrator",
              data: { name: error instanceof Error ? error.name : "UnknownError" },
            })],
          }),
        };
        await checkpoint();
      }
    }
    if (status !== "interrupted") {
      status = runs.some(({ run }) => run.technicalStatus === "failed")
        ? "completed_with_failures"
        : "completed";
      await emit(status === "completed" ? "plan_completed" : "plan_completed_with_failures");
      await checkpoint();
    }
    return stateSnapshot();
  } finally {
    await session.close();
  }
}
