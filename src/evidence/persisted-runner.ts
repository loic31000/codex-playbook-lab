import type { ExperimentExecutionBackend, ExperimentAgentExecutor } from "../experiment/execution-backend.js";
import {
  runExperimentPlan,
  validateExperimentExecutionState,
  type ExperimentExecutionState,
  type RunExperimentPlanInput,
} from "../experiment/orchestrator.js";
import type { ExperimentExecutionPlan } from "../experiment/plan.js";
import { canonicalJson } from "../experiment/canonical-json.js";
import { FilesystemEvidenceStore } from "./filesystem-evidence-store.js";
import {
  RecordingExperimentExecutionBackend,
  type EvidenceStorageHooks,
} from "./recording-backend.js";

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
  readonly storageHooks?: EvidenceStorageHooks;
}

async function reconcileFinalizedAttempts(input: {
  readonly store: FilesystemEvidenceStore;
  readonly plan: ExperimentExecutionPlan;
  readonly state: ExperimentExecutionState;
  readonly targetPath: string;
}): Promise<ExperimentExecutionState> {
  validateExperimentExecutionState(input.plan, input.state);
  const runs = [...input.state.runs];
  const events = [...input.state.events];
  let recovered = false;
  for (let index = 0; index < runs.length; index += 1) {
    const logicalRun = runs[index]!;
    if (logicalRun.run.technicalStatus !== "running") continue;
    const summary = (await input.store.listRunAttempts(input.plan.fingerprint, logicalRun.plannedRunId))
      .find(({ attempt }) => attempt === logicalRun.attempt);
    if (!summary || summary.status !== "finalized") continue;
    const stored = await input.store.readAttempt(
      input.plan.fingerprint,
      logicalRun.plannedRunId,
      logicalRun.attempt,
    );
    const manifest = stored.manifest!;
    if (input.state.baseline === undefined || canonicalJson(manifest.baseline) !== canonicalJson(input.state.baseline)) {
      throw new Error("finalized attempt baseline differs from the durable checkpoint baseline");
    }
    if (manifest.terminalEvent.sequence !== events.length + 1) {
      throw new Error("finalized attempt terminal event does not continue the durable event history");
    }
    events.push(manifest.terminalEvent);
    runs[index] = {
      ...logicalRun,
      attempt: manifest.attempt,
      run: manifest.experimentRun,
      facts: undefined,
    };
    recovered = true;
  }
  if (!recovered) return input.state;
  const reconciled: ExperimentExecutionState = {
    ...input.state,
    runs,
    events,
  };
  validateExperimentExecutionState(input.plan, reconciled);
  await input.store.appendCheckpoint(input.plan, reconciled, [input.targetPath]);
  return reconciled;
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
    hooks: input.storageHooks,
  });
  const previousState = input.resume && latest.checkpoint
    ? await reconcileFinalizedAttempts({
        store: input.store,
        plan: input.plan,
        state: latest.checkpoint.state,
        targetPath: input.targetPath,
      })
    : undefined;
  return runExperimentPlan({
    plan: input.plan,
    backend: recordingBackend,
    targetPath: input.targetPath,
    executor: input.executor,
    ...(previousState === undefined ? {} : { previousState }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    onCheckpoint: async (state) => {
      await recordingBackend.checkpoint(state);
      await input.onCheckpoint?.(state);
    },
  });
}
