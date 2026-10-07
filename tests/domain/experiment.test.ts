import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HUMAN_REVIEW_LABELS,
  HUMAN_REVIEW_STATUSES,
  TECHNICAL_STATUSES,
  createEvidence,
  createExperiment,
  createExperimentRun,
  createTestCase,
  parseExperimentJson,
  parseHumanDecisionStatus,
  parseHumanReviewStatus,
  parseTechnicalStatus,
  recordHumanReview,
  serializeExperiment,
  updateRunTechnicalState,
  type TestCase,
} from "../../src/domain/index.js";

const fixtureJson = readFileSync("tests/fixtures/experiment.complete.json", "utf8");

function fixtureValue(): Record<string, unknown> {
  return JSON.parse(fixtureJson) as Record<string, unknown>;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function generatedProvenance(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const instruction = "Genere un cas limite.";
  return {
    generatorId: "generator",
    generatorVersion: "1.0.0",
    generatedAt: "2026-10-05T10:00:00.000Z",
    instruction: { kind: "content", value: instruction },
    instructionVersion: "instruction-v1",
    instructionFingerprint: fingerprint(instruction),
    model: "fake-model",
    modelOptions: { temperature: 0 },
    target: { id: "target", source: "git", revision: "abc123" },
    contentFingerprint: fingerprint(content),
    reproducibility: "not_guaranteed",
    ...overrides,
  };
}

describe("Experiment domain foundation", () => {
  it("construit un Experiment complet avec target, deux types de cas, run et evidence", () => {
    const experiment = parseExperimentJson(fixtureJson);

    expect(experiment.id).toBe("experiment-addition-v1");
    expect(experiment.target).toEqual({
      id: "math-fixture",
      source: "git",
      revision: "96bbdd2cf9cd8b01f21d77759bb8b5b190f4bf44",
    });
    expect(experiment.promptVersion.promptDefinitionId).toBe(experiment.promptDefinition.id);
    expect(experiment.testCases.map(({ kind }) => kind)).toEqual(["fixed", "generated"]);
    expect(experiment.runs[0]?.evidence[0]?.type).toBe("test-result");
  });

  it("refuse un Experiment sans id, target, PromptVersion ou cas", () => {
    const missingId = fixtureValue();
    delete missingId.id;
    expect(() => createExperiment(missingId)).toThrow(/experiment.id must be a non-empty string/);

    const missingTarget = fixtureValue();
    delete missingTarget.target;
    expect(() => createExperiment(missingTarget)).toThrow(/target must be an object/);

    const missingPromptVersion = fixtureValue();
    delete missingPromptVersion.promptVersion;
    expect(() => createExperiment(missingPromptVersion)).toThrow(/promptVersion must be an object/);

    expect(() => createExperiment({ ...fixtureValue(), testCases: [] })).toThrow(/at least one case/);
  });

  it("utilise un contrat TestCase discrimine sans imposer de provenance aux cas fixes", () => {
    const cases: TestCase[] = [
      createTestCase({ kind: "fixed", id: "fixed", title: "Fixe", input: "Tache stable" }),
      createTestCase({
        kind: "generated",
        id: "generated",
        title: "Genere",
        input: "Tache generee",
        provenance: generatedProvenance("Tache generee"),
      }),
    ];

    expect(cases.map(({ id }) => id)).toEqual(["fixed", "generated"]);
    expect(cases[0]?.kind).toBe("fixed");
    expect("provenance" in cases[0]!).toBe(false);
    expect(cases[1]?.kind).toBe("generated");
    if (cases[1]?.kind === "generated") {
      expect(cases[1].provenance.generatorId).toBe("generator");
    }
  });

  it("rend la provenance obligatoire pour un GeneratedCase", () => {
    expect(() => createTestCase({ kind: "generated", id: "generated", title: "Genere", input: "Tache" }))
      .toThrow(/provenance must be an object/);

    expect(createTestCase({
      kind: "generated",
      id: "generated",
      title: "Genere",
      input: "Tache",
      provenance: generatedProvenance("Tache", { seed: "stable-seed" }),
    }).kind).toBe("generated");
  });

  it("refuse un fingerprint de contenu incorrect", () => {
    expect(() => createTestCase({
      kind: "generated",
      id: "generated",
      title: "Genere",
      input: "Tache exacte\r\n",
      provenance: generatedProvenance("autre contenu"),
    })).toThrow(/contentFingerprint does not match/);
  });

  it("rend le GeneratedCase accepte par Experiment immuable", () => {
    const experiment = parseExperimentJson(fixtureJson);
    const generated = experiment.testCases.find(({ kind }) => kind === "generated");
    expect(generated?.kind).toBe("generated");
    expect(Object.isFrozen(generated)).toBe(true);
    if (generated?.kind !== "generated") throw new Error("generated fixture missing");
    const originalInput = generated.input;
    const originalOptions = generated.provenance.modelOptions;
    expect(() => {
      (generated as { input: string }).input = "texte remplace";
    }).toThrow(TypeError);
    expect(() => {
      (originalOptions as { temperature: number }).temperature = 1;
    }).toThrow(TypeError);
    expect(generated.input).toBe(originalInput);
    expect(generated.provenance.contentFingerprint).toBe(fingerprint(originalInput));
    expect(generated.provenance.modelOptions).toEqual({ temperature: 0.2, maxOutputTokens: 2048 });
  });

  it("valide separement les statuts techniques et humains", () => {
    expect(TECHNICAL_STATUSES.map(parseTechnicalStatus)).toEqual([
      "pending", "running", "completed", "failed", "cancelled",
    ]);
    expect(HUMAN_REVIEW_STATUSES.map(parseHumanReviewStatus)).toEqual([
      "pending_review", "approved", "rejected", "uncertain",
    ]);
    expect(HUMAN_REVIEW_LABELS).toEqual({
      pending_review: "À vérifier",
      approved: "Validé",
      rejected: "Refusé",
      uncertain: "Incertain",
    });
    expect(new Set(Object.values(HUMAN_REVIEW_LABELS)).size).toBe(4);
    expect(() => parseTechnicalStatus("approved")).toThrow(/unknown TechnicalStatus/);
    expect(() => parseHumanReviewStatus("completed")).toThrow(/unknown HumanReviewStatus/);
  });

  it("termine un run et ajoute des preuves sans produire de verdict humain", () => {
    const running = createExperimentRun({
      id: "run-1",
      experimentId: "experiment-1",
      testCaseId: "case-1",
      technicalStatus: "running",
      startedAt: "2026-10-05T10:00:00.000Z",
    });
    const completed = updateRunTechnicalState(running, {
      technicalStatus: "completed",
      finishedAt: "2026-10-05T10:00:10.000Z",
      exitCode: 0,
      durationMs: 10000,
      evidence: [{ type: "exit-code", recordedAt: "2026-10-05T10:00:10.000Z", source: "runner", data: { value: 0 } }],
    });

    expect(running.humanReviewStatus).toBe("pending_review");
    expect(completed.technicalStatus).toBe("completed");
    expect(completed.humanReviewStatus).toBe("pending_review");
    expect(completed.evidence).toHaveLength(1);
  });

  it.each(["approved", "rejected", "uncertain"] as const)(
    "enregistre la decision humaine %s sans modifier le statut technique",
    (status) => {
      const run = createExperimentRun({
        id: `run-${status}`,
        experimentId: "experiment-1",
        testCaseId: "case-1",
        technicalStatus: "completed",
      });
      const reviewed = recordHumanReview(run, {
        status,
        reviewer: "reviewer-1",
        reviewedAt: "2026-10-05T11:00:00.000Z",
      });
      expect(reviewed.technicalStatus).toBe("completed");
      expect(reviewed.humanReviewStatus).toBe(status);
    },
  );

  it("refuse pending_review comme nouvelle decision humaine", () => {
    const run = createExperimentRun({ id: "run-1", experimentId: "experiment-1", testCaseId: "case-1" });
    expect(() => parseHumanDecisionStatus("pending_review")).toThrow(/unknown HumanDecisionStatus/);
    expect(() => recordHumanReview(run, {
      status: "pending_review" as never,
      reviewer: "reviewer-1",
      reviewedAt: "2026-10-05T11:00:00.000Z",
    })).toThrow(/unknown HumanDecisionStatus/);
  });

  it("exige toujours un target explicite sans consulter cwd ou le repository du Lab", () => {
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("process.cwd must not be called");
    });
    try {
      expect(() => createExperiment({ ...fixtureValue(), target: undefined })).toThrow(/target must be an object/);
      expect(parseExperimentJson(fixtureJson).target.id).toBe("math-fixture");
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });

  it.each(["failedTests", "duration", "exitCode", "tokenCount"])(
    "accepte la metrique objective %s",
    (name) => {
      expect(createEvidence({
        type: "test-result",
        recordedAt: "2026-10-05T10:00:00.000Z",
        source: "runner",
        metric: { name, value: 42 },
        data: { passedTests: 1, changedFiles: 0, status: "completed" },
      }).metric?.name).toBe(name);
    },
  );

  it.each(["approved", "winner"])("refuse le verdict %s dans Evidence.type", (type) => {
    expect(() => createEvidence({
      type,
      recordedAt: "2026-10-05T10:00:00.000Z",
      source: "automation",
    })).toThrow(/verdict, not evidence/);
  });

  it.each(["betterPrompt", "better_prompt", "Better-Prompt"])(
    "normalise et refuse %s dans Evidence.metric.name",
    (name) => {
      expect(() => createEvidence({
        type: "metric",
        recordedAt: "2026-10-05T10:00:00.000Z",
        source: "automation",
        metric: { name, value: 1 },
      })).toThrow(/verdict, not evidence/);
    },
  );

  it("refuse les cles de verdict imbriquees dans Evidence.data", () => {
    expect(() => createEvidence({
      type: "comparison-fact",
      recordedAt: "2026-10-05T10:00:00.000Z",
      source: "automation",
      data: { result: { winner: "treatment" } },
    })).toThrow(/verdict, not evidence/);
  });

  it.each([
    ["status", "approved"],
    ["review", "rejected"],
    ["status", "uncertain"],
    ["human", "pending_review"],
  ])(
    "refuse %s=%s comme valeur Evidence structuree",
    (field, status) => {
      expect(() => createEvidence({
        type: "structured-fact",
        recordedAt: "2026-10-05T10:00:00.000Z",
        source: "automation",
        data: { result: { [field]: status } },
      })).toThrow(/human review status, not evidence/);
    },
  );

  it("effectue un round-trip JSON stable avec discriminants et validation runtime", () => {
    const experiment = parseExperimentJson(fixtureJson);
    const serialized = serializeExperiment(experiment);
    expect(parseExperimentJson(serialized)).toEqual(experiment);
    expect(serializeExperiment(parseExperimentJson(serialized))).toBe(serialized);
    expect(() => parseExperimentJson("{invalid")).toThrow(/invalid Experiment JSON/);
  });
});
