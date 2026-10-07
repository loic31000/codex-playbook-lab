import {
  createExperiment,
  type Experiment,
  type GeneratedCase,
  type TargetRef,
  type TestCase,
} from "../domain/index.js";
import { canonicalJson, deepFreezeCopy, sha256Canonical, sha256Exact } from "./canonical-json.js";
import type { ExperimentVariant } from "./model-input.js";

export interface PlannedRun {
  readonly id: string;
  readonly ordinal: number;
  readonly experimentId: string;
  readonly promptVersionId: string;
  readonly promptContentFingerprint: string;
  readonly testCaseId: string;
  readonly testCaseKind: TestCase["kind"];
  readonly caseInputFingerprint: string;
  readonly repetition: number;
  readonly variant: ExperimentVariant;
}

export interface ExperimentExecutionPlan {
  readonly id: string;
  readonly fingerprint: string;
  readonly target: TargetRef;
  readonly experiments: readonly Experiment[];
  readonly plannedRuns: readonly PlannedRun[];
}

function sameTarget(left: TargetRef, right: TargetRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertGeneratedTarget(testCase: GeneratedCase, target: TargetRef, experimentId: string): void {
  if (!sameTarget(testCase.provenance.target, target)) {
    throw new Error(`GeneratedCase ${testCase.id} target differs from Experiment ${experimentId} target`);
  }
  if (sha256Exact(testCase.input) !== testCase.provenance.contentFingerprint) {
    throw new Error(`GeneratedCase ${testCase.id} content fingerprint differs from its exact input`);
  }
}

export function createExperimentExecutionPlan(input: {
  readonly id: string;
  readonly experiments: readonly Experiment[];
}): ExperimentExecutionPlan {
  if (typeof input.id !== "string" || input.id.trim() === "") throw new TypeError("plan.id must be a non-empty string");
  if (!Array.isArray(input.experiments) || input.experiments.length === 0) {
    throw new TypeError("plan.experiments must contain at least one Experiment");
  }
  const experiments = input.experiments.map(createExperiment);
  const target = experiments[0]!.target;
  const experimentIds = new Set<string>();
  for (const experiment of experiments) {
    if (experimentIds.has(experiment.id)) throw new TypeError(`plan contains duplicate Experiment id ${experiment.id}`);
    experimentIds.add(experiment.id);
    if (!sameTarget(experiment.target, target)) throw new Error("all plan Experiments must use the same TargetRef");
    if (experiment.runs.length !== 0) {
      throw new Error(`Experiment ${experiment.id} contains historical runs; orchestration state must remain separate`);
    }
    for (const testCase of experiment.testCases) {
      if (testCase.kind === "generated") assertGeneratedTarget(testCase, experiment.target, experiment.id);
    }
  }

  const plannedRuns: PlannedRun[] = [];
  for (const experiment of experiments) {
    const promptContentFingerprint = sha256Exact(experiment.promptVersion.content);
    for (const testCase of experiment.testCases) {
      const caseInputFingerprint = sha256Exact(testCase.input);
      for (let repetition = 1; repetition <= experiment.configuration.repetitions; repetition += 1) {
        for (const variant of ["baseline", "treatment"] as const) {
          const ordinal = plannedRuns.length + 1;
          const logicalIdentity = {
            experimentId: experiment.id,
            promptVersionId: experiment.promptVersion.id,
            testCaseId: testCase.id,
            repetition,
            variant,
          };
          plannedRuns.push({
            id: `${input.id}-${String(ordinal).padStart(4, "0")}-${sha256Canonical(logicalIdentity).slice(0, 12)}`,
            ordinal,
            ...logicalIdentity,
            promptContentFingerprint,
            testCaseKind: testCase.kind,
            caseInputFingerprint,
          });
        }
      }
    }
  }
  const fingerprint = sha256Canonical({ id: input.id, target, experiments, plannedRuns });
  return deepFreezeCopy({ id: input.id, fingerprint, target, experiments, plannedRuns });
}

export function findPlannedRunContext(plan: ExperimentExecutionPlan, plannedRun: PlannedRun): {
  readonly experiment: Experiment;
  readonly testCase: TestCase;
} {
  const experiment = plan.experiments.find(({ id }) => id === plannedRun.experimentId);
  if (!experiment) throw new Error(`unknown Experiment for PlannedRun ${plannedRun.id}`);
  const testCase = experiment.testCases.find(({ id }) => id === plannedRun.testCaseId);
  if (!testCase) throw new Error(`unknown TestCase for PlannedRun ${plannedRun.id}`);
  return { experiment, testCase };
}
