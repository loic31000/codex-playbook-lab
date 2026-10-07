import { describe, expect, it } from "vitest";

import {
  createExperiment,
  createPromptDefinition,
  createPromptVersion,
  createTestCase,
  type JsonObject,
} from "../../src/domain/index.js";
import {
  GENERATION_INPUT_SEPARATOR,
  buildGenerationModelInput,
  createGeneratorPromptVersion,
  fingerprintExactText,
  generateExploratoryCases,
  type ExploratoryCaseGenerator,
  type ExploratoryGeneratorOutput,
  type GenerateCasesInput,
} from "../../src/explore/index.js";

const generatedAt = "2026-10-07T08:00:00.000Z";
const target = { id: "target-repository", source: "git", revision: "abc123" } as const;
const generatorPrompt = createGeneratorPromptVersion({
  id: "exploratory-cases-v1",
  content: "Propose trois cas exploratoires sans les juger.\r\n",
});
const promptDefinition = createPromptDefinition({ id: "studied-prompt", name: "Prompt étudié" });
const promptVersion = createPromptVersion({
  id: "studied-prompt@v1",
  promptDefinitionId: promptDefinition.id,
  content: "Implémente exactement la Story fournie.\n",
  fingerprint: fingerprintExactText("Implémente exactement la Story fournie.\n"),
});
const exactFirst = "# Cas limite\r\n\r\nConserve les espaces.  \r\n";
const similarButDifferent = "# Cas limite\n\nConserve les espaces.\n";
const oracleSentinel = "BENCHMARK_ORACLE_SENTINEL_26";

function output(overrides: Partial<ExploratoryGeneratorOutput> = {}): ExploratoryGeneratorOutput {
  return {
    model: "fake-model-2026-10",
    modelOptions: { temperature: 0.7, topP: 0.9, responseFormat: { type: "markdown" } },
    cases: [
      { title: "Cas CRLF", markdown: exactFirst },
      { title: "Cas similaire", markdown: similarButDifferent },
      { title: "Cas dupliqué exact", markdown: exactFirst },
    ],
    ...overrides,
  };
}

function fakeGenerator(
  generatorOutput: ExploratoryGeneratorOutput,
  requests: Array<Record<string, unknown>> = [],
): ExploratoryCaseGenerator {
  return {
    id: "fake-exploratory-generator",
    version: "2.1.0",
    async generate(request) {
      requests.push({ ...request });
      return generatorOutput;
    },
  };
}

function generationInput(
  generator: ExploratoryCaseGenerator,
  overrides: Partial<GenerateCasesInput> = {},
): GenerateCasesInput {
  return {
    generationId: "generation-26",
    generatorPrompt,
    promptVersion,
    target,
    generator,
    requestedSeed: 1234,
    parentRef: "parent-experiment",
    now: () => new Date(generatedAt),
    ...overrides,
  };
}

function completeProvenance(markdown: string): Record<string, unknown> {
  const instruction = buildGenerationModelInput({ generatorPrompt, promptVersion });
  return {
    generatorId: "fake-exploratory-generator",
    generatorVersion: "2.1.0",
    generatedAt,
    instruction: { kind: "content", value: instruction },
    instructionVersion: generatorPrompt.id,
    instructionFingerprint: fingerprintExactText(instruction),
    model: "fake-model-2026-10",
    modelOptions: { temperature: 0.7 },
    target,
    contentFingerprint: fingerprintExactText(markdown),
    reproducibility: "not_guaranteed",
  };
}

describe("traceable exploratory generated cases", () => {
  it("produit trois GeneratedCase exacts, uniques et complètement tracés", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const input = {
      ...generationInput(fakeGenerator(output(), requests)),
      oracle: oracleSentinel,
      expectation: "winner",
    } as GenerateCasesInput;
    const result = await generateExploratoryCases(input);

    expect(result.status).toBe("generated");
    expect(result.cases).toHaveLength(3);
    expect(new Set(result.cases.map(({ id }) => id)).size).toBe(3);
    expect(result.cases.map(({ input: markdown }) => markdown)).toEqual([
      exactFirst,
      similarButDifferent,
      exactFirst,
    ]);
    expect(result.cases[0]!.input).toBe(exactFirst);
    expect(result.cases[0]!.input).toContain("\r\n\r\n");
    expect(result.cases[0]!.input.endsWith("  \r\n")).toBe(true);
    expect(result.generatorPrompt).toEqual(generatorPrompt);
    expect(result.promptVersionId).toBe(promptVersion.id);
    expect(result.model).toBe("fake-model-2026-10");
    expect(result.modelOptions).toEqual({ temperature: 0.7, topP: 0.9, responseFormat: { type: "markdown" } });
    expect(result.reproducibility).toBe("not_guaranteed");
    expect(result).not.toHaveProperty("seedUsed");

    const first = result.cases[0]!;
    expect(first.provenance).toEqual({
      generatorId: "fake-exploratory-generator",
      generatorVersion: "2.1.0",
      generatedAt,
      instruction: {
        kind: "content",
        value: `${generatorPrompt.content}${GENERATION_INPUT_SEPARATOR}${promptVersion.content}`,
      },
      instructionVersion: generatorPrompt.id,
      instructionFingerprint: fingerprintExactText(
        `${generatorPrompt.content}${GENERATION_INPUT_SEPARATOR}${promptVersion.content}`,
      ),
      model: "fake-model-2026-10",
      modelOptions: { temperature: 0.7, topP: 0.9, responseFormat: { type: "markdown" } },
      target,
      contentFingerprint: fingerprintExactText(exactFirst),
      reproducibility: "not_guaranteed",
      parentRef: "parent-experiment",
    });
    expect(requests).toEqual([{
      generationId: "generation-26",
      modelInput: `${generatorPrompt.content}${GENERATION_INPUT_SEPARATOR}${promptVersion.content}`,
      target,
      requestedSeed: 1234,
    }]);
    expect(Object.keys(requests[0]!).sort()).toEqual(["generationId", "modelInput", "requestedSeed", "target"]);
    expect(requests[0]!.modelInput).not.toContain(oracleSentinel);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(oracleSentinel);
    expect(serialized).not.toMatch(/winner|betterPrompt|worsePrompt|verdict|humanReviewStatus|score/i);
  });

  it("versionne le prompt générateur avec le SHA-256 du contenu exact", () => {
    expect(generatorPrompt.fingerprint).toBe(fingerprintExactText(generatorPrompt.content));
    expect(createGeneratorPromptVersion({
      id: generatorPrompt.id,
      content: generatorPrompt.content.replace("\r\n", "\n"),
    }).fingerprint).not.toBe(generatorPrompt.fingerprint);
    expect(() => createGeneratorPromptVersion({
      id: generatorPrompt.id,
      content: generatorPrompt.content,
      fingerprint: "0".repeat(64),
    })).toThrow(/does not match/);
  });

  it("construit l'input uniquement depuis les deux PromptVersion", () => {
    expect(buildGenerationModelInput({ generatorPrompt, promptVersion })).toBe(
      `${generatorPrompt.content}${GENERATION_INPUT_SEPARATOR}${promptVersion.content}`,
    );
    expect(buildGenerationModelInput).toHaveLength(1);
  });

  it("enregistre une seed uniquement lorsque l'adapter confirme seedUsed", async () => {
    const withoutConfirmation = await generateExploratoryCases(generationInput(fakeGenerator(output())));
    expect(withoutConfirmation).not.toHaveProperty("seedUsed");
    expect(withoutConfirmation.cases[0]!.provenance).not.toHaveProperty("seed");

    const confirmed = await generateExploratoryCases(generationInput(fakeGenerator(output({ seedUsed: 9876 }))));
    expect(confirmed.seedUsed).toBe(9876);
    expect(confirmed.cases[0]!.provenance.seed).toBe(9876);
    expect(confirmed.reproducibility).toBe("not_guaranteed");
    expect(confirmed.cases[0]!.provenance.reproducibility).toBe("not_guaranteed");
  });

  it("ne marque deterministic que lorsque l'adapter le déclare explicitement", async () => {
    const result = await generateExploratoryCases(generationInput(fakeGenerator(output({
      reproducibility: "deterministic",
    }))));
    expect(result.reproducibility).toBe("deterministic");
    expect(result.cases.every(({ provenance }) => provenance.reproducibility === "deterministic")).toBe(true);
    expect(result).not.toHaveProperty("seedUsed");
  });

  it("détecte seulement les doublons Markdown exacts sans les supprimer", async () => {
    const result = await generateExploratoryCases(generationInput(fakeGenerator(output())));
    expect(result.cases).toHaveLength(3);
    expect(result.exactDuplicates).toEqual([{
      contentFingerprint: fingerprintExactText(exactFirst),
      caseIds: [result.cases[0]!.id, result.cases[2]!.id],
    }]);
    expect(result.exactDuplicates[0]!.caseIds).not.toContain(result.cases[1]!.id);
    expect(result.cases[1]!.provenance.contentFingerprint).not.toBe(
      result.cases[0]!.provenance.contentFingerprint,
    );
  });

  it("retourne explicitement no_cases pour une génération vide", async () => {
    const result = await generateExploratoryCases(generationInput(fakeGenerator(output({ cases: [] }))));
    expect(result.status).toBe("no_cases");
    expect(result.cases).toEqual([]);
    expect(result.exactDuplicates).toEqual([]);
    expect(result.model).toBe("fake-model-2026-10");
  });

  it("rejette provenance, modèle, target et instructionFingerprint manquants", async () => {
    expect(() => createTestCase({ kind: "generated", id: "case", title: "Case", input: exactFirst }))
      .toThrow(/provenance must be an object/);

    await expect(generateExploratoryCases(generationInput(fakeGenerator(output({ model: "" })))))
      .rejects.toThrow(/generatorOutput.model must be a non-empty string/);

    await expect(generateExploratoryCases({
      ...generationInput(fakeGenerator(output())),
      target: undefined,
    } as unknown as GenerateCasesInput)).rejects.toThrow(/target must be an object/);

    const missingFingerprint = completeProvenance(exactFirst);
    delete missingFingerprint.instructionFingerprint;
    expect(() => createTestCase({
      kind: "generated",
      id: "case",
      title: "Case",
      input: exactFirst,
      provenance: missingFingerprint,
    })).toThrow(/instructionFingerprint/);
  });

  it("rejette les fingerprints d'instruction et de contenu incohérents", () => {
    expect(() => createTestCase({
      kind: "generated",
      id: "case-instruction",
      title: "Case",
      input: exactFirst,
      provenance: { ...completeProvenance(exactFirst), instructionFingerprint: "0".repeat(64) },
    })).toThrow(/instructionFingerprint does not match/);
    expect(() => createTestCase({
      kind: "generated",
      id: "case-content",
      title: "Case",
      input: exactFirst,
      provenance: { ...completeProvenance(exactFirst), contentFingerprint: "0".repeat(64) },
    })).toThrow(/contentFingerprint does not match/);
  });

  it("copie les modelOptions factuelles au lieu de conserver une référence mutable", async () => {
    const modelOptions: JsonObject = { temperature: 0.4, nested: { effort: "high" } };
    const generatorOutput = output({ modelOptions });
    const result = await generateExploratoryCases(generationInput(fakeGenerator(generatorOutput)));
    (modelOptions as { temperature: number }).temperature = 1;
    ((modelOptions.nested as { effort: string })).effort = "low";
    expect(result.cases[0]!.provenance.modelOptions).toEqual({
      temperature: 0.4,
      nested: { effort: "high" },
    });
  });

  it("un Experiment conserve le texte exact et l'identité immuable des cas acceptés", async () => {
    const proposals = output().cases.map((proposal) => ({ ...proposal }));
    const result = await generateExploratoryCases(generationInput(fakeGenerator(output({ cases: proposals }))));
    const experiment = createExperiment({
      id: "experiment-generated-26",
      promptDefinition,
      promptVersion,
      target,
      testCases: result.cases,
      configuration: { repetitions: 1 },
      runs: [],
    });
    (proposals[0] as { markdown: string }).markdown = "contenu remplacé";
    expect(experiment.testCases[0]!.input).toBe(exactFirst);
    expect(Object.isFrozen(experiment.testCases[0])).toBe(true);
    expect(() => {
      (experiment.testCases[0] as { input: string }).input = "mutation silencieuse";
    }).toThrow(TypeError);
    expect(experiment.testCases[0]!.input).toBe(exactFirst);
    if (experiment.testCases[0]!.kind !== "generated") throw new Error("generated case missing");
    expect(experiment.testCases[0]!.provenance.contentFingerprint).toBe(fingerprintExactText(exactFirst));
  });
});
