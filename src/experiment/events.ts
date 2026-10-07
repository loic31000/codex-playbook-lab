import type { ExperimentVariant } from "./model-input.js";

export type ExperimentExecutionEventType =
  | "plan_started"
  | "plan_resumed"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_skipped"
  | "plan_interrupted"
  | "plan_completed"
  | "plan_completed_with_failures";

export interface ExperimentEventBase {
  readonly type: ExperimentExecutionEventType;
  readonly sequence: number;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly timestamp: string;
}

export interface ExperimentPlanEvent extends ExperimentEventBase {
  readonly type:
    | "plan_started"
    | "plan_resumed"
    | "plan_interrupted"
    | "plan_completed"
    | "plan_completed_with_failures";
}

export interface ExperimentRunEvent extends ExperimentEventBase {
  readonly type: "run_started" | "run_completed" | "run_failed" | "run_cancelled" | "run_skipped";
  readonly plannedRunId: string;
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly variant: ExperimentVariant;
  readonly repetition: number;
  readonly attempt: number;
}

export type ExperimentExecutionEvent = ExperimentPlanEvent | ExperimentRunEvent;
