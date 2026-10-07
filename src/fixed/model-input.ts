import type { FixedCase, PromptVersion } from "../domain/index.js";
import {
  EXPERIMENT_INPUT_SEPARATOR,
  buildExperimentModelInput,
  type ExperimentVariant,
} from "../experiment/model-input.js";

export type FixedBenchmarkVariant = ExperimentVariant;

// This separator is part of the reproducibility contract. It deliberately
// contains no benchmark metadata and changes only with an explicit API change.
export const FIXED_BENCHMARK_INPUT_SEPARATOR = EXPERIMENT_INPUT_SEPARATOR;

export function buildFixedBenchmarkModelInput(input: {
  readonly variant: FixedBenchmarkVariant;
  readonly promptVersion: PromptVersion;
  readonly testCase: FixedCase;
}): string {
  return buildExperimentModelInput(input);
}
