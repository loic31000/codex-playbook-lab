import type { PromptVersion } from "../domain/index.js";
import type { GeneratorPromptVersion } from "./generator-prompt.js";

// This separator is part of the generation input contract. No benchmark,
// oracle, review, or experiment result is accepted by this API.
export const GENERATION_INPUT_SEPARATOR = "\n\n---\n\n";

export function buildGenerationModelInput(input: {
  readonly generatorPrompt: GeneratorPromptVersion;
  readonly promptVersion: PromptVersion;
}): string {
  return `${input.generatorPrompt.content}${GENERATION_INPUT_SEPARATOR}${input.promptVersion.content}`;
}
