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
        provenance: {
          generatorId: "generator",
          generatedAt: "2026-10-05T10:00:00.000Z",
          instruction: { kind: "reference", value: "prompts/generator-v1.md" },
        },
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
      provenance: {
        generatorId: "generator",
        generatedAt: "2026-10-05T10:00:00.000Z",
        seed: "stable-seed",
        instruction: { kind: "content", value: "Genere un cas limite." },
      },
    }).kind).toBe("generated");
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

    const reviewed = recordHumanReview(completed, {
      status: "approved",
      reviewer: "reviewer-1",
      reviewedAt: "2026-10-05T11:00:00.000Z",
      comment: "Revue humaine terminee.",
    });
    expect(reviewed.technicalStatus).toBe("completed");
    expect(reviewed.humanReviewStatus).toBe("approved");
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

  it("conserve Evidence factuelle et refuse les champs de verdict", () => {
    expect(createEvidence({
      type: "duration",
      recordedAt: "2026-10-05T10:00:00.000Z",
      source: "runner",
      metric: { name: "duration", value: 42, unit: "ms" },
      data: { exitCode: 0, tests: { passed: 1, failed: 0 } },
    }).metric?.value).toBe(42);

    expect(() => createEvidence({
      type: "judge",
      recordedAt: "2026-10-05T10:00:00.000Z",
      source: "automation",
      data: { winner: "treatment" },
    })).toThrow(/verdict, not evidence/);
  });

  it("effectue un round-trip JSON stable avec discriminants et validation runtime", () => {
    const experiment = parseExperimentJson(fixtureJson);
    const serialized = serializeExperiment(experiment);
    expect(parseExperimentJson(serialized)).toEqual(experiment);
    expect(serializeExperiment(parseExperimentJson(serialized))).toBe(serialized);
    expect(() => parseExperimentJson("{invalid")).toThrow(/invalid Experiment JSON/);
  });
});
