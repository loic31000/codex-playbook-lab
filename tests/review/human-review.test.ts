import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createExperimentRun,
  transitionHumanReview,
  type HumanReviewStatus,
} from "../../src/domain/index.js";
import { canonicalJson, sha256Canonical } from "../../src/experiment/index.js";
import {
  humanReviewRecordFingerprint,
  readCurrentHumanReview,
  readHumanReviewHistory,
  readReviewedRun,
  recordHumanReview,
} from "../../src/review/index.js";
import { createReviewFixture, removeReviewFixture } from "./helpers.js";

const statuses: readonly HumanReviewStatus[] = ["pending_review", "approved", "rejected", "uncertain"];

function reviewDirectory(root: string, planFingerprint: string, plannedRunId: string): string {
  return path.join(root, "plans", planFingerprint, "reviews", Buffer.from(plannedRunId).toString("base64url"));
}

async function rewriteReview(filename: string, mutate: (record: Record<string, unknown>) => void): Promise<void> {
  const record = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
  mutate(record);
  delete record.recordFingerprint;
  record.recordFingerprint = sha256Canonical(record);
  await fs.writeFile(filename, `${canonicalJson(record)}\n`, "utf8");
}

describe("human review", () => {
  it("autorise toutes les transitions explicites en preservant les champs techniques", () => {
    const original = createExperimentRun({
      id: "run",
      experimentId: "experiment",
      testCaseId: "case",
      technicalStatus: "failed",
      startedAt: "2026-10-08T08:00:00.000Z",
      changedFiles: ["src/file.ts"],
      evidence: [{ type: "tests-failed", source: "runner", recordedAt: "2026-10-08T08:01:00.000Z" }],
    });
    for (const from of statuses) {
      const current = transitionHumanReview(original, {
        status: from,
        reviewer: "first-reviewer",
        reviewedAt: "2026-10-08T09:00:00.000Z",
        comment: "first comment",
      });
      for (const to of statuses) {
        const next = transitionHumanReview(current, {
          status: to,
          reviewer: "next-reviewer",
          reviewedAt: "2026-10-08T10:00:00.000Z",
          comment: "next comment",
        });
        expect(next.humanReviewStatus).toBe(to);
        expect({ ...next, humanReviewStatus: original.humanReviewStatus, reviewer: undefined, reviewedAt: undefined,
          reviewComment: undefined }).toEqual({ ...original, reviewer: undefined, reviewedAt: undefined,
          reviewComment: undefined });
        if (to === "pending_review") {
          expect(next).not.toHaveProperty("reviewer");
          expect(next).not.toHaveProperty("reviewedAt");
          expect(next).not.toHaveProperty("reviewComment");
        }
      }
    }
  });

  it("ne deduit jamais une revue des statuts, exit codes ou Evidence techniques", async () => {
    const fixture = await createReviewFixture({ exitCodes: [0, 7] });
    try {
      for (const plannedRun of fixture.plan.plannedRuns) {
        const current = await readCurrentHumanReview({
          store: fixture.store,
          planFingerprint: fixture.plan.fingerprint,
          plannedRunId: plannedRun.id,
        });
        const reviewed = await readReviewedRun({
          store: fixture.store,
          planFingerprint: fixture.plan.fingerprint,
          plannedRunId: plannedRun.id,
        });
        expect(current).toEqual({ status: "pending_review", latest: null });
        expect(reviewed.humanReviewStatus).toBe("pending_review");
        expect(reviewed.technicalStatus).toBe(plannedRun.ordinal === 1 ? "completed" : "failed");
        expect(reviewed.evidence[0]?.type).toBe(plannedRun.ordinal === 1 ? "tests-passed" : "tests-failed");
      }
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("journalise approved, rejected, uncertain puis reset avec une chaine stricte", async () => {
    const fixture = await createReviewFixture();
    const plannedRun = fixture.plan.plannedRuns[0]!;
    try {
      const attempt = await fixture.store.readAttempt(fixture.plan.fingerprint, plannedRun.id, 1);
      if (!attempt.manifest || !attempt.summary.manifestRef) throw new Error("manifest fixture missing");
      const manifestPath = path.join(fixture.store.root, ...attempt.summary.manifestRef.split("/"));
      const manifestBefore = await fs.readFile(manifestPath);
      const technicalBefore = attempt.manifest.experimentRun;
      const decisions = ["approved", "rejected", "uncertain", "pending_review"] as const;
      for (const [index, status] of decisions.entries()) {
        await recordHumanReview({
          store: fixture.store,
          planFingerprint: fixture.plan.fingerprint,
          plannedRunId: plannedRun.id,
          status,
          reviewer: `reviewer-${index + 1}`,
          reviewedAt: `2026-10-08T1${index}:00:00.000Z`,
          comment: `comment-${index + 1}`,
        });
      }
      const history = await readHumanReviewHistory({
        store: fixture.store,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId: plannedRun.id,
      });
      expect(history.map(({ sequence, previousStatus, status, reviewer, comment }) => ({
        sequence, previousStatus, status, reviewer, comment,
      }))).toEqual([
        { sequence: 1, previousStatus: "pending_review", status: "approved", reviewer: "reviewer-1", comment: "comment-1" },
        { sequence: 2, previousStatus: "approved", status: "rejected", reviewer: "reviewer-2", comment: "comment-2" },
        { sequence: 3, previousStatus: "rejected", status: "uncertain", reviewer: "reviewer-3", comment: "comment-3" },
        { sequence: 4, previousStatus: "uncertain", status: "pending_review", reviewer: "reviewer-4", comment: "comment-4" },
      ]);
      expect(new Set(history.map(({ sourceAttemptRef }) => sourceAttemptRef))).toEqual(new Set([attempt.summary.manifestRef]));
      expect(new Set(history.map(({ sourceAttemptFingerprint }) => sourceAttemptFingerprint))).toEqual(
        new Set([sha256Canonical(attempt.manifest)]),
      );
      expect(history.every((record) => humanReviewRecordFingerprint(record) === record.recordFingerprint)).toBe(true);
      const reviewed = await readReviewedRun({
        store: fixture.store,
        planFingerprint: fixture.plan.fingerprint,
        plannedRunId: plannedRun.id,
      });
      expect(reviewed.humanReviewStatus).toBe("pending_review");
      expect(reviewed).not.toHaveProperty("reviewer");
      expect(reviewed).not.toHaveProperty("reviewedAt");
      expect(reviewed).not.toHaveProperty("reviewComment");
      expect({ ...reviewed, humanReviewStatus: technicalBefore.humanReviewStatus }).toEqual(technicalBefore);
      expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("garde un run failed et ses Evidence inchanges pendant approved puis reset", async () => {
    const fixture = await createReviewFixture({ exitCodes: [3, 0] });
    const plannedRun = fixture.plan.plannedRuns[0]!;
    try {
      const before = await readReviewedRun({ store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id });
      await recordHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
        status: "approved", reviewer: "human", reviewedAt: "2026-10-08T12:00:00.000Z",
      });
      const approved = await readReviewedRun({ store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id });
      expect(approved.technicalStatus).toBe("failed");
      expect(approved.humanReviewStatus).toBe("approved");
      expect(approved.evidence).toEqual(before.evidence);
      await recordHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
        status: "pending_review", reviewer: "human", reviewedAt: "2026-10-08T13:00:00.000Z",
      });
      const reset = await readReviewedRun({ store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id });
      expect(reset.technicalStatus).toBe("failed");
      expect(reset.humanReviewStatus).toBe("pending_review");
      expect(reset.evidence).toEqual(before.evidence);
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it.each([
    ["plan fingerprint", (record: Record<string, unknown>) => { record.planFingerprint = "f".repeat(64); }],
    ["planned run", (record: Record<string, unknown>) => { record.plannedRunId = "other-run"; }],
    ["attempt", (record: Record<string, unknown>) => { record.attempt = 2; }],
    ["source fingerprint", (record: Record<string, unknown>) => { record.sourceAttemptFingerprint = "a".repeat(64); }],
    ["sequence", (record: Record<string, unknown>) => { record.sequence = 9; }],
    ["previous status", (record: Record<string, unknown>) => { record.previousStatus = "uncertain"; }],
    ["unknown status", (record: Record<string, unknown>) => { record.status = "automatic-winner"; }],
    ["invalid reviewer", (record: Record<string, unknown>) => { record.reviewer = ""; }],
    ["invalid timestamp", (record: Record<string, unknown>) => { record.reviewedAt = "yesterday"; }],
  ] as const)("echoue ferme sur un audit falsifie: %s", async (_label, mutate) => {
    const fixture = await createReviewFixture();
    const plannedRun = fixture.plan.plannedRuns[0]!;
    try {
      await recordHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
        status: "approved", reviewer: "reviewer", reviewedAt: "2026-10-08T12:00:00.000Z",
      });
      await recordHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
        status: "rejected", reviewer: "reviewer", reviewedAt: "2026-10-08T13:00:00.000Z",
      });
      const filename = path.join(reviewDirectory(fixture.store.root, fixture.plan.fingerprint, plannedRun.id), "00000002.json");
      await rewriteReview(filename, mutate);
      await expect(readCurrentHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
      })).rejects.toThrow();
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("propage les erreurs de journal au lieu de revenir a une ancienne decision", async () => {
    const fixture = await createReviewFixture();
    const plannedRun = fixture.plan.plannedRuns[0]!;
    try {
      await recordHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
        status: "approved", reviewer: "reviewer", reviewedAt: "2026-10-08T12:00:00.000Z",
      });
      const directory = reviewDirectory(fixture.store.root, fixture.plan.fingerprint, plannedRun.id);
      await fs.writeFile(path.join(directory, "00000002.json"), "{broken", "utf8");
      await expect(readCurrentHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
      })).rejects.toThrow();
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("refuse un fingerprint de record falsifie", async () => {
    const fixture = await createReviewFixture();
    const plannedRun = fixture.plan.plannedRuns[0]!;
    try {
      await recordHumanReview({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
        status: "approved", reviewer: "reviewer", reviewedAt: "2026-10-08T12:00:00.000Z",
      });
      const filename = path.join(reviewDirectory(fixture.store.root, fixture.plan.fingerprint, plannedRun.id), "00000001.json");
      const record = JSON.parse(await fs.readFile(filename, "utf8")) as Record<string, unknown>;
      record.recordFingerprint = "0".repeat(64);
      await fs.writeFile(filename, `${canonicalJson(record)}\n`, "utf8");
      await expect(readHumanReviewHistory({
        store: fixture.store, planFingerprint: fixture.plan.fingerprint, plannedRunId: plannedRun.id,
      })).rejects.toThrow(/fingerprint/);
    } finally {
      await removeReviewFixture(fixture);
    }
  });
});
