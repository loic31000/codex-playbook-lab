import type { ExperimentExecutionBackend, ExperimentAgentExecutor } from "../experiment/execution-backend.js";
import {
  runExperimentPlan,
  type ExperimentExecutionState,
  type RunExperimentPlanInput,
} from "../experiment/orchestrator.js";
import type { ExperimentExecutionPlan } from "../experiment/plan.js";
import { FilesystemEvidenceStore } from "./filesystem-evidence-store.js";
import { RecordingExperimentExecutionBackend } from "./recording-backend.js";

export interface RunStoredExperimentPlanInput {
  readonly store: FilesystemEvidenceStore;
  readonly plan: ExperimentExecutionPlan;
  readonly backend: ExperimentExecutionBackend;
  readonly targetPath: string;
  readonly executor: ExperimentAgentExecutor;
  readonly resume?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: RunExperimentPlanInput["now"];
  readonly onEvent?: RunExperimentPlanInput["onEvent"];
  readonly onCheckpoint?: (state: ExperimentExecutionState) => void | Promise<void>;
}

export async function runStoredExperimentPlan(
  input: RunStoredExperimentPlanInput,
): Promise<ExperimentExecutionState> {
  await input.store.writePlan(input.plan, [input.targetPath]);
  const latest = await input.store.readLatestCheckpoint(input.plan.fingerprint);
  if (!input.resume && latest.checkpoint) {
    throw new Error("stored checkpoints already exist; explicitly request resume to continue this plan");
  }
  const recordingBackend = new RecordingExperimentExecutionBackend({
    backend: input.backend,
    store: input.store,
    plan: input.plan,
  });
  return runExperimentPlan({
    plan: input.plan,
    backend: recordingBackend,
    targetPath: input.targetPath,
    executor: input.executor,
    ...(input.resume && latest.checkpoint ? { previousState: latest.checkpoint.state } : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    onCheckpoint: async (state) => {
      await recordingBackend.checkpoint(state);
      await input.onCheckpoint?.(state);
    },
  });
}
