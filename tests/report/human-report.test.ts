import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/experiment/index.js";
import { openEvidenceStore, type FilesystemEvidenceStore } from "../../src/evidence/index.js";
import {
  buildExperimentReport,
  renderExperimentReportMarkdown,
  serializeExperimentReportJson,
} from "../../src/report/index.js";
import {
  createCompleteReportFixture,
  createCrashedReportFixture,
  createEmptyReportFixture,
  createInterruptedReportFixture,
  createManifestAheadFixture,
  removeReportFixture,
  snapshotTree,
  type ReportFixture,
} from "./helpers.js";

const fixtures: ReportFixture[] = [];

async function complete(): Promise<ReportFixture> {
  const fixture = await createCompleteReportFixture();
  fixtures.push(fixture);
  return fixture;
}

function absoluteFromRef(fixture: ReportFixture, ref: string): string {
  return path.join(fixture.storeRoot, ...ref.split("/"));
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(removeReportFixture));
});

describe("factual human report", () => {
  it("construit les agregats techniques et humains exacts avec sources", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report).toMatchObject({
      format: "codex-playbook-lab-report",
      version: 1,
      completeness: { complete: true, reasons: [] },
      plan: { id: "complete-report-plan", plannedRunCount: 4 },
    });
    expect(report.summary.technicalStatuses.completed).toEqual({
      count: 3,
      plannedRunIds: [fixture.plan.plannedRuns[0]!.id, fixture.plan.plannedRuns[2]!.id, fixture.plan.plannedRuns[3]!.id],
    });
    expect(report.summary.technicalStatuses.failed).toEqual({
      count: 1,
      plannedRunIds: [fixture.plan.plannedRuns[1]!.id],
    });
    expect(report.summary.humanReviewStatuses).toMatchObject({
      pending_review: { count: 1, plannedRunIds: [fixture.plan.plannedRuns[2]!.id] },
      approved: { count: 1, plannedRunIds: [fixture.plan.plannedRuns[0]!.id] },
      rejected: { count: 1, plannedRunIds: [fixture.plan.plannedRuns[1]!.id] },
      uncertain: { count: 1, plannedRunIds: [fixture.plan.plannedRuns[3]!.id] },
    });
    expect(report.summary.pendingReviewRunIds).toEqual([fixture.plan.plannedRuns[2]!.id]);
    expect(report.summary.reviewActions.count).toBe(3);
    for (const aggregate of Object.values(report.summary.technicalStatuses)) {
      expect(aggregate.count).toBe(aggregate.plannedRunIds.length);
    }
    for (const aggregate of Object.values(report.summary.humanReviewStatuses)) {
      expect(aggregate.count).toBe(aggregate.plannedRunIds.length);
    }
  });

  it("agrege seulement les durees et workspaces reellement connus", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.summary.durations).toMatchObject({ knownRunCount: 4, totalMs: 450 });
    expect(report.summary.durations.observations.map(({ durationMs }) => durationMs)).toEqual([100, 150, 90, 110]);
    expect(report.summary.changedFiles).toMatchObject({
      knownRunCount: 4,
      runsWithChanges: { count: 3 },
      runsWithoutChanges: { count: 1, plannedRunIds: [fixture.plan.plannedRuns[2]!.id] },
    });
    expect(report.summary.changedFiles.union.map(({ path }) => path)).toEqual([
      "src/base-only.ts", "src/case-two.ts", "src/shared.ts", "src/treatment-only.ts",
    ]);
    expect(report.summary.durations.totalMs).toBe(
      report.summary.durations.observations.reduce((sum, entry) => sum + entry.durationMs, 0),
    );
  });

  it("compte chaque Evidence et chaque metrique explicite avec tracabilite", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.summary.evidenceTypes.map(({ type, count }) => ({ type, count }))).toEqual([
      { type: "command-execution", count: 4 },
      { type: "test-result", count: 8 },
    ]);
    expect(report.summary.evidenceTypes.every(({ count, sources }) => count === sources.length)).toBe(true);
    expect(report.summary.metrics.map(({ name, unit, observationCount, sum, min, max }) => (
      { name, unit, observationCount, sum, min, max }
    ))).toEqual([
      { name: "tests.failed", unit: "count", observationCount: 4, sum: 1, min: 0, max: 1 },
      { name: "tests.passed", unit: "count", observationCount: 4, sum: 13, min: 2, max: 4 },
    ]);
    expect(report.summary.metrics.every(({ observationCount, observations }) => (
      observationCount === observations.length
    ))).toBe(true);
  });

  it("produit uniquement des comparaisons A/B factuelles par cas", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.comparisons).toHaveLength(2);
    expect(report.comparisons[0]).toMatchObject({
      testCaseId: "case-alpha",
      comparisonComplete: true,
      treatmentMinusBaselineMs: 50,
      baseline: { technicalStatus: "completed", exitCode: 0, durationMs: 100 },
      treatment: { technicalStatus: "failed", exitCode: 2, durationMs: 150 },
      changedFiles: {
        shared: ["src/shared.ts"],
        baselineOnly: ["src/base-only.ts"],
        treatmentOnly: ["src/treatment-only.ts"],
      },
      fingerprints: {
        sameTestCaseFingerprint: true,
        sameTargetFingerprint: true,
        sameRunnerFingerprint: true,
        sameConfigurationFingerprint: true,
      },
    });
    expect(report.comparisons[1]).toMatchObject({
      testCaseId: "case-beta",
      treatmentMinusBaselineMs: 20,
      changedFiles: { shared: [], baselineOnly: [], treatmentOnly: ["src/case-two.ts"] },
    });
  });

  it("rend le JSON et Markdown stables depuis le meme objet et echappe les donnees humaines", async () => {
    const fixture = await complete();
    const first = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const second = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const json = serializeExperimentReportJson(first);
    const markdown = renderExperimentReportMarkdown(first);

    expect(second).toEqual(first);
    expect(serializeExperimentReportJson(second)).toBe(json);
    expect(renderExperimentReportMarkdown(second)).toBe(markdown);
    expect(json).toBe(`${canonicalJson(first)}\n`);
    expect(markdown).toContain("> État : COMPLÈTE");
    expect(markdown).toContain("Décision humaine courante");
    expect(markdown).toContain("Alice \\| QA");
    expect(markdown).toContain("Human \\*\\*comment\\*\\*<br>\\# alpha");
    expect(markdown).toContain("## Runs à vérifier");
  });

  it("correspond byte-for-byte aux golden JSON et Markdown de la fixture complete", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const [expectedJson, expectedMarkdown] = await Promise.all([
      fs.readFile("tests/fixtures/report/expected-report.json", "utf8"),
      fs.readFile("tests/fixtures/report/expected-report.md", "utf8"),
    ]);

    expect(serializeExperimentReportJson(report)).toBe(expectedJson);
    expect(renderExperimentReportMarkdown(report)).toBe(expectedMarkdown);
  });

  it("reste stable apres reouverture du store et ne modifie aucun fichier", async () => {
    const fixture = await complete();
    const before = await snapshotTree(fixture.storeRoot);
    const first = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    expect(await snapshotTree(fixture.storeRoot)).toEqual(before);
    const reopened = await openEvidenceStore(fixture.storeRoot);
    const second = await buildExperimentReport({ store: reopened, planFingerprint: fixture.plan.fingerprint });
    expect(second).toEqual(first);
    expect(await snapshotTree(fixture.storeRoot)).toEqual(before);
  });

  it("produit un rapport incomplet sans checkpoint ni faits inventes", async () => {
    const fixture = await createEmptyReportFixture();
    fixtures.push(fixture);
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.source.checkpoint).toBeNull();
    expect(report.completeness).toEqual({
      complete: false,
      reasons: ["no_checkpoint", "non_terminal_runs"],
    });
    expect(report.runs.every((run) => (
      run.technicalStatus === "pending"
      && run.attempt === 0
      && run.attempts.length === 0
      && run.manifest === null
      && run.exitCode === undefined
      && run.durationMs === undefined
      && run.changedFiles === undefined
      && run.humanReview.origin === "default_pending"
    ))).toBe(true);
    expect(report.summary.durations).toMatchObject({ knownRunCount: 0, totalMs: null, observations: [] });
    expect(report.summary.changedFiles.knownRunCount).toBe(0);
    expect(renderExperimentReportMarkdown(report)).toContain("> État : INCOMPLÈTE");
  });

  it("montre un crash, une attempt partielle et une comparaison partielle", async () => {
    const fixture = await createCrashedReportFixture();
    fixtures.push(fixture);
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.completeness).toEqual({
      complete: false,
      reasons: ["execution_running", "non_terminal_runs", "partial_attempts"],
    });
    expect(report.runs.map(({ technicalStatus }) => technicalStatus)).toEqual(["completed", "running", "pending", "pending"]);
    expect(report.runs[1]).toMatchObject({ attempt: 1, manifest: null, attempts: [{ attempt: 1, status: "partial" }] });
    expect(report.runs[1]).not.toHaveProperty("exitCode");
    expect(report.runs[1]).not.toHaveProperty("durationMs");
    expect(report.runs[1]).not.toHaveProperty("changedFiles");
    expect(report.comparisons[0]?.comparisonComplete).toBe(false);
    expect(report.comparisons[0]?.missingFacts).toContain("treatment.manifest");
  });

  it("projette une orchestration interrompue avec cancelled et pending sans faits inventes", async () => {
    const fixture = await createInterruptedReportFixture();
    fixtures.push(fixture);
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.source.checkpoint?.executionStatus).toBe("interrupted");
    expect(report.completeness.reasons).toEqual([
      "execution_interrupted", "non_terminal_runs", "partial_attempts",
    ]);
    expect(report.runs.map(({ technicalStatus }) => technicalStatus)).toEqual([
      "completed", "cancelled", "pending", "pending",
    ]);
    expect(report.runs[1]?.attempts).toEqual([expect.objectContaining({ status: "partial" })]);
    expect(report.runs[1]).not.toHaveProperty("exitCode");
    expect(report.runs[1]).not.toHaveProperty("durationMs");
    expect(report.runs[1]?.humanReview).toMatchObject({ status: "pending_review", origin: "default_pending" });
  });

  it("signale un manifest finalise en avance sans reconciler ni ecrire", async () => {
    const fixture = await createManifestAheadFixture();
    fixtures.push(fixture);
    const before = await snapshotTree(fixture.storeRoot);
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.runs[0]?.technicalStatus).toBe("running");
    expect(report.runs[0]?.manifest).toBeNull();
    expect(report.runs[0]?.attempts).toEqual([
      expect.objectContaining({ attempt: 1, status: "finalized" }),
    ]);
    expect(report.completeness.reasons).toContain("finalized_attempt_ahead_of_checkpoint");
    expect(await fixture.store.listRunAttempts(fixture.plan.fingerprint, fixture.plan.plannedRuns[0]!.id)).toHaveLength(1);
    expect(await snapshotTree(fixture.storeRoot)).toEqual(before);
  });

  it("refuse tout checkpoint invalide au lieu d'utiliser silencieusement l'ancien", async () => {
    const fixture = await complete();
    const directory = path.join(fixture.storeRoot, "plans", fixture.plan.fingerprint, "checkpoints");
    await fs.writeFile(path.join(directory, "99999999.json"), "{invalid", "utf8");
    await expect(buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint }))
      .rejects.toThrow(/invalid checkpoints/);
  });

  it("refuse un manifest terminal falsifie", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const manifestRef = report.runs[0]!.manifest!.ref;
    const filename = absoluteFromRef(fixture, manifestRef);
    const manifest = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
    manifest.exitCode = 99;
    await fs.writeFile(filename, `${canonicalJson(manifest)}\n`, "utf8");
    await expect(buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint }))
      .rejects.toThrow();
  });

  it("refuse un journal humain falsifie sans revenir au statut precedent", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const reviewRef = report.runs[0]!.humanReview.history[0]!.sourceRef;
    const filename = absoluteFromRef(fixture, reviewRef);
    const review = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
    review.comment = "tampered";
    await fs.writeFile(filename, `${canonicalJson(review)}\n`, "utf8");
    await expect(buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint }))
      .rejects.toThrow(/fingerprint/);
  });

  it("propage une erreur filesystem operationnelle", async () => {
    const fixture = await complete();
    const denied = new Proxy(fixture.store, {
      get(target, property, receiver) {
        if (property === "readPlan") {
          return async () => { throw Object.assign(new Error("I/O denied"), { code: "EACCES" }); };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as FilesystemEvidenceStore;
    await expect(buildExperimentReport({ store: denied, planFingerprint: fixture.plan.fingerprint }))
      .rejects.toMatchObject({ code: "EACCES" });
  });

  it("ne contient que des refs portables et aucun gros blob", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const json = serializeExperimentReportJson(report);

    fixture.store.assertPortable(report, [fixture.targetPath]);
    expect(json).not.toContain(fixture.root);
    expect(json).not.toMatch(/[A-Za-z]:\\|\/tmp\/|\/home\//);
    expect(json).not.toContain("output-1");
    expect(json).not.toContain("stdout-1");
    expect(json).not.toContain("diff --git");
    expect(report.runs[0]?.manifest?.artifacts.finalOutput).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteLength: expect.any(Number),
      mediaType: "text/plain; charset=utf-8",
      ref: expect.stringMatching(/^blobs\/sha256\//),
    });
  });

  it("ne produit aucune conclusion qualitative ou action automatique", async () => {
    const fixture = await complete();
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });
    const rendered = `${serializeExperimentReportJson(report)}\n${renderExperimentReportMarkdown(report)}`;

    expect(rendered).not.toMatch(/\b(winner|betterPrompt|worsePrompt|correctAnswer|isCorrect|qualityScore|verdict|recommendation|conclusion)\b/i);
    expect(report.runs[1]?.technicalStatus).toBe("failed");
    expect(report.runs[1]?.humanReview.status).toBe("rejected");
    expect(report.runs[2]?.technicalStatus).toBe("completed");
    expect(report.runs[2]?.humanReview.status).toBe("pending_review");
  });

  it("laisse completed et failed en pending_review sans action humaine", async () => {
    const fixture = await createCompleteReportFixture("report-without-reviews", false);
    fixtures.push(fixture);
    const report = await buildExperimentReport({ store: fixture.store, planFingerprint: fixture.plan.fingerprint });

    expect(report.runs.map(({ technicalStatus }) => technicalStatus)).toEqual([
      "completed", "failed", "completed", "completed",
    ]);
    expect(report.runs.every(({ humanReview }) => (
      humanReview.status === "pending_review" && humanReview.origin === "default_pending"
    ))).toBe(true);
    expect(report.summary.humanReviewStatuses.pending_review.count).toBe(4);
    expect(report.summary.reviewActions.count).toBe(0);
  });
});
