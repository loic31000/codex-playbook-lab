import {
  REPRODUCIBILITY_MODES,
  createPromptVersion,
  createTargetRef,
  createTestCase,
  type GeneratedCase,
  type JsonObject,
  type JsonValue,
  type PromptVersion,
  type Reproducibility,
  type TargetRef,
} from "../domain/index.js";
import type { ExploratoryCaseGenerator, ExploratoryGeneratorOutput } from "./generated-case-generator.js";
import { buildGenerationModelInput } from "./generation-input.js";
import {
  createGeneratorPromptVersion,
  fingerprintExactText,
  type GeneratorPromptVersion,
} from "./generator-prompt.js";

export interface ExactDuplicateGroup {
  readonly contentFingerprint: string;
  readonly caseIds: readonly string[];
}

export interface GeneratedCasesResult {
  readonly status: "generated" | "no_cases";
  readonly generationId: string;
  readonly generatorPrompt: GeneratorPromptVersion;
  readonly promptVersionId: string;
  readonly target: TargetRef;
  readonly model: string;
  readonly modelOptions: JsonObject;
  readonly reproducibility: Reproducibility;
  readonly seedUsed?: string | number;
  readonly cases: readonly GeneratedCase[];
  readonly exactDuplicates: readonly ExactDuplicateGroup[];
}

export interface GenerateCasesInput {
  readonly generationId: string;
  readonly generatorPrompt: GeneratorPromptVersion;
  readonly promptVersion: PromptVersion;
  readonly target: TargetRef;
  readonly generator: ExploratoryCaseGenerator;
  readonly requestedSeed?: string | number;
  readonly parentRef?: string;
  readonly now?: () => Date;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function copyJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => copyJson(entry, `${path}[${index}]`));
  if (typeof value !== "object") throw new TypeError(`${path} must contain only JSON values`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, copyJson(entry, `${path}.${key}`)]),
  );
}

function copyModelOptions(value: unknown): JsonObject {
  const copied = copyJson(value, "generatorOutput.modelOptions");
  if (!isJsonObject(copied)) {
    throw new TypeError("generatorOutput.modelOptions must be a JSON object");
  }
  return copied;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSeed(value: unknown, path: string): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`${path} must be a string or number`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
  return value;
}

function parseOutput(output: ExploratoryGeneratorOutput): {
  readonly model: string;
  readonly modelOptions: JsonObject;
  readonly seedUsed?: string | number;
  readonly reproducibility: Reproducibility;
  readonly cases: ExploratoryGeneratorOutput["cases"];
} {
  if (typeof output !== "object" || output === null) throw new TypeError("generatorOutput must be an object");
  const model = nonEmptyString(output.model, "generatorOutput.model");
  const modelOptions = copyModelOptions(output.modelOptions);
  const seedUsed = parseSeed(output.seedUsed, "generatorOutput.seedUsed");
  const reproducibility = output.reproducibility ?? "not_guaranteed";
  if (!REPRODUCIBILITY_MODES.includes(reproducibility)) {
    throw new TypeError(`unknown generatorOutput.reproducibility: ${String(reproducibility)}`);
  }
  if (!Array.isArray(output.cases)) throw new TypeError("generatorOutput.cases must be an array");
  return { model, modelOptions, seedUsed, reproducibility, cases: output.cases };
}

function exactDuplicateGroups(cases: readonly GeneratedCase[]): readonly ExactDuplicateGroup[] {
  const idsByFingerprint = new Map<string, string[]>();
  for (const testCase of cases) {
    const ids = idsByFingerprint.get(testCase.provenance.contentFingerprint) ?? [];
    ids.push(testCase.id);
    idsByFingerprint.set(testCase.provenance.contentFingerprint, ids);
  }
  return [...idsByFingerprint.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([contentFingerprint, caseIds]) => ({ contentFingerprint, caseIds }));
}

export async function generateExploratoryCases(input: GenerateCasesInput): Promise<GeneratedCasesResult> {
  const generationId = nonEmptyString(input.generationId, "generationId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(generationId)) {
    throw new TypeError("generationId contains unsupported characters");
  }
  const generatorId = nonEmptyString(input.generator?.id, "generator.id");
  const generatorVersion = input.generator.version === undefined
    ? undefined
    : nonEmptyString(input.generator.version, "generator.version");
  const generatorPrompt = createGeneratorPromptVersion(input.generatorPrompt);
  const promptVersion = createPromptVersion(input.promptVersion);
  const target = Object.freeze(createTargetRef(input.target));
  const requestedSeed = parseSeed(input.requestedSeed, "requestedSeed");
  const modelInput = buildGenerationModelInput({ generatorPrompt, promptVersion });
  const parsed = parseOutput(await input.generator.generate({
    generationId,
    modelInput,
    target,
    ...(requestedSeed === undefined ? {} : { requestedSeed }),
  }));
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const instructionFingerprint = fingerprintExactText(modelInput);
  const cases = parsed.cases.map((proposal, index) => {
    if (typeof proposal !== "object" || proposal === null) {
      throw new TypeError(`generatorOutput.cases[${index}] must be an object`);
    }
    const title = nonEmptyString(proposal.title, `generatorOutput.cases[${index}].title`);
    const markdown = nonEmptyString(proposal.markdown, `generatorOutput.cases[${index}].markdown`);
    const contentFingerprint = fingerprintExactText(markdown);
    const provenance = {
      generatorId,
      ...(generatorVersion === undefined ? {} : { generatorVersion }),
      generatedAt,
      instruction: { kind: "content" as const, value: modelInput },
      instructionVersion: generatorPrompt.id,
      instructionFingerprint,
      model: parsed.model,
      modelOptions: parsed.modelOptions,
      target,
      contentFingerprint,
      reproducibility: parsed.reproducibility,
      ...(parsed.seedUsed === undefined ? {} : { seed: parsed.seedUsed }),
      ...(input.parentRef === undefined ? {} : { parentRef: input.parentRef }),
    };
    const testCase = createTestCase({
      kind: "generated",
      id: `${generationId}-${String(index + 1).padStart(3, "0")}-${contentFingerprint.slice(0, 12)}`,
      title,
      input: markdown,
      provenance,
    });
    if (testCase.kind !== "generated") throw new Error("generated case factory returned an unexpected kind");
    return testCase;
  });
  return {
    status: cases.length === 0 ? "no_cases" : "generated",
    generationId,
    generatorPrompt,
    promptVersionId: promptVersion.id,
    target,
    model: parsed.model,
    modelOptions: parsed.modelOptions,
    reproducibility: parsed.reproducibility,
    ...(parsed.seedUsed === undefined ? {} : { seedUsed: parsed.seedUsed }),
    cases,
    exactDuplicates: exactDuplicateGroups(cases),
  };
}
