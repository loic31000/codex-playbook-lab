import type { FixedCase, PromptVersion } from "../domain/index.js";

export type FixedBenchmarkVariant = "baseline" | "treatment";

// This separator is part of the reproducibility contract. It deliberately
// contains no benchmark metadata and changes only with an explicit API change.
export const FIXED_BENCHMARK_INPUT_SEPARATOR = "\n\n---\n\n";

export function buildFixedBenchmarkModelInput(input: {
  readonly variant: FixedBenchmarkVariant;
  readonly promptVersion: PromptVersion;
  readonly testCase: FixedCase;
}): string {
  if (input.variant === "baseline") return input.testCase.input;
  if (input.variant === "treatment") {
    return `${input.promptVersion.content}${FIXED_BENCHMARK_INPUT_SEPARATOR}${input.testCase.input}`;
  }
  throw new TypeError(`unknown fixed benchmark variant: ${String(input.variant)}`);
}
