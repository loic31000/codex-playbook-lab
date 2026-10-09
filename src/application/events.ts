import type { JsonObject } from "../domain/index.js";

export type ApplicationEventType =
  | "operation_started"
  | "operation_completed"
  | "operation_failed"
  | "operation_cancel_requested"
  | "operation_cancelled"
  | "experiment_event"
  | "cases_generated"
  | "report_built"
  | "human_review_recorded"
  | "case_promoted"
  | "diagnostics_completed";

export interface ApplicationEvent {
  readonly type: ApplicationEventType;
  readonly operationId?: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly payload: JsonObject;
}

export type ApplicationEventSink = (event: ApplicationEvent) => void | Promise<void>;

export function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
