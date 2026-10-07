import type { PromptVersion, TestCase } from "../domain/index.js";

export type ExperimentVariant = "baseline" | "treatment";

export const EXPERIMENT_INPUT_SEPARATOR = "\n\n---\n\n";

export function buildExperimentModelInput(input: {
  readonly variant: ExperimentVariant;
  readonly promptVersion: PromptVersion;
  readonly testCase: TestCase;
}): string {
  if (input.variant === "baseline") return input.testCase.input;
  if (input.variant === "treatment") {
    return `${input.promptVersion.content}${EXPERIMENT_INPUT_SEPARATOR}${input.testCase.input}`;
  }
  throw new TypeError(`unknown experiment variant: ${String(input.variant)}`);
}
