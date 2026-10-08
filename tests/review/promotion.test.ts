import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Exact } from "../../src/experiment/index.js";
import {
  buildFixedBenchmarkModelInput,
  discoverFixedBenchmarks,
  type DiscoveredPrompt,
} from "../../src/fixed/index.js";
import {
  promoteGeneratedCase,
  readCasePromotion,
  recordHumanReview,
} from "../../src/review/index.js";
import {
  createReviewFixture,
  exactGeneratedInput,
  promotionCommentSentinel,
  provenanceSentinel,
  removeReviewFixture,
  reviewCommentSentinel,
} from "./helpers.js";

function promptFor(fixture: Awaited<ReturnType<typeof createReviewFixture>>): DiscoveredPrompt {
  const experiment = fixture.plan.experiments[0]!;
  return {
    definition: experiment.promptDefinition,
    version: experiment.promptVersion,
    sourcePath: "playbook/09-01.md",
    relativePath: "09-01.md",
    sourceFingerprint: "a".repeat(64),
  };
}

async function review(
  fixture: Awaited<ReturnType<typeof createReviewFixture>>,
  status: "approved" | "rejected" | "uncertain" = "approved",
): Promise<void> {
  await recordHumanReview({
    store: fixture.store,
    planFingerprint: fixture.plan.fingerprint,
    plannedRunId: fixture.plan.plannedRuns[0]!.id,
    status,
    reviewer: "human-reviewer",
    reviewedAt: "2026-10-08T12:00:00.000Z",
    comment: reviewCommentSentinel,
  });
}

async function promote(
  fixture: Awaited<ReturnType<typeof createReviewFixture>>,
  fixedCaseId = "011-generated-regression",
) {
  return promoteGeneratedCase({
    store: fixture.store,
    planFingerprint: fixture.plan.fingerprint,
    plannedRunId: fixture.plan.plannedRuns[0]!.id,
    benchmarksDir: fixture.benchmarksDir,
    fixedCaseId,
    title: "Regression exploratoire",
    expectation: "implementation",
    promotedBy: "human-promoter",
    promotedAt: "2026-10-08T13:00:00.000Z",
    comment: promotionCommentSentinel,
  });
}

describe("GeneratedCase promotion", () => {
  it("refuse pending_review et ne promeut rien automatiquement apres approved", async () => {
    const fixture = await createReviewFixture();
    try {
      await expect(promote(fixture)).rejects.toThrow(/non-pending human review/);
      expect(await fs.readdir(fixture.benchmarksDir)).toEqual([]);
      await review(fixture, "approved");
      expect(await fs.readdir(fixture.benchmarksDir)).toEqual([]);
      expect(await readCasePromotion(fixture.store, sha256Exact(exactGeneratedInput))).toBeNull();
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it.each(["approved", "rejected", "uncertain"] as const)(
    "promeut explicitement un cas apres une decision %s",
    async (status) => {
      const fixture = await createReviewFixture({ id: `promotion-${status}` });
      try {
        await review(fixture, status);
        const result = await promote(fixture, `011-${status}-regression`);
        expect(result.metadata.source.review.status).toBe(status);
        expect(result.audit.expectation).toBe("implementation");
        expect(path.isAbsolute(result.audit.benchmarkPath)).toBe(false);
        expect(path.isAbsolute(result.audit.metadataPath)).toBe(false);
        expect(await readCasePromotion(fixture.store, sha256Exact(exactGeneratedInput))).toEqual(result.audit);
      } finally {
        await removeReviewFixture(fixture);
      }
    },
  );

  it("preserve exactement le body, son SHA et toute la provenance sans exposer la metadata au modele", async () => {
    const fixture = await createReviewFixture();
    try {
      await review(fixture, "rejected");
      const technical = await fixture.store.readAttempt(
        fixture.plan.fingerprint,
        fixture.plan.plannedRuns[0]!.id,
        1,
      );
      if (!technical.manifest || !technical.summary.manifestRef) throw new Error("manifest fixture missing");
      const manifestPath = path.join(fixture.store.root, ...technical.summary.manifestRef.split("/"));
      const manifestBefore = await fs.readFile(manifestPath);
      const result = await promote(fixture);
      const markdown = await fs.readFile(result.benchmarkPath, "utf8");
      expect(markdown.slice(markdown.indexOf("---\n", 4) + 4)).toBe(exactGeneratedInput);
      const [discovered] = await discoverFixedBenchmarks(fixture.benchmarksDir, [promptFor(fixture)]);
      expect(discovered?.testCase.input).toBe(exactGeneratedInput);
      expect(sha256Exact(discovered!.testCase.input)).toBe(sha256Exact(exactGeneratedInput));
      const generated = fixture.plan.experiments[0]!.testCases[0]!;
      if (generated.kind !== "generated") throw new Error("generated fixture missing");
      expect(discovered?.promotion?.sourceGeneratedCase.provenance).toEqual(generated.provenance);
      expect(discovered?.promotion?.sourceGeneratedCase.contentFingerprint).toBe(generated.provenance.contentFingerprint);
      for (const variant of ["baseline", "treatment"] as const) {
        const modelInput = buildFixedBenchmarkModelInput({
          variant,
          promptVersion: fixture.plan.experiments[0]!.promptVersion,
          testCase: discovered!.testCase,
        });
        expect(modelInput).not.toContain(provenanceSentinel);
        expect(modelInput).not.toContain(reviewCommentSentinel);
        expect(modelInput).not.toContain(promotionCommentSentinel);
        expect(modelInput).not.toContain("expectation: implementation");
        expect(modelInput).not.toContain("codex-lab-benchmark-promotion");
      }
      expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("n'invente aucune seed absente pendant le round-trip", async () => {
    const fixture = await createReviewFixture({ id: "promotion-without-seed", includeSeed: false });
    try {
      await review(fixture);
      const result = await promote(fixture, "011-without-seed");
      expect(result.metadata.sourceGeneratedCase.provenance).not.toHaveProperty("seed");
      const [discovered] = await discoverFixedBenchmarks(fixture.benchmarksDir, [promptFor(fixture)]);
      expect(discovered?.promotion?.sourceGeneratedCase.provenance).not.toHaveProperty("seed");
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("refuse la double promotion du meme GeneratedCase", async () => {
    const fixture = await createReviewFixture();
    try {
      await review(fixture);
      await promote(fixture);
      await expect(promote(fixture, "012-another-id")).rejects.toThrow(/already promoted/);
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("echoue ferme sur un audit de promotion corrompu", async () => {
    const fixture = await createReviewFixture();
    try {
      await review(fixture);
      const result = await promote(fixture);
      const fingerprint = result.metadata.sourceGeneratedCase.contentFingerprint;
      const auditPath = path.join(fixture.store.root, "promotions", `${fingerprint}.json`);
      const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as Record<string, unknown>;
      audit.recordFingerprint = "0".repeat(64);
      await fs.writeFile(auditPath, `${JSON.stringify(audit)}\n`, "utf8");
      await expect(readCasePromotion(fixture.store, fingerprint)).rejects.toThrow(/invalid/);
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it("refuse les collisions d'id et les destinations partielles sans ecraser", async () => {
    const fixture = await createReviewFixture();
    try {
      await review(fixture);
      const promptDirectory = path.join(fixture.benchmarksDir, "09-01-implementer-story");
      await fs.mkdir(promptDirectory, { recursive: true });
      await fs.writeFile(path.join(promptDirectory, "existing.md"), [
        "---", "format: codex-lab-benchmark", "id: 011-collision", "prompt: 09-01-implementer-story",
        "title: Existing", "expectation: implementation", "---", "Existing body",
      ].join("\n"), "utf8");
      await expect(promote(fixture, "011-collision")).rejects.toThrow(/id already exists/);
      await fs.writeFile(path.join(promptDirectory, "012-partial.md"), "partial", "utf8");
      await expect(promote(fixture, "012-partial")).rejects.toThrow(/partial promotion destination/);
      expect(await fs.readFile(path.join(promptDirectory, "012-partial.md"), "utf8")).toBe("partial");
    } finally {
      await removeReviewFixture(fixture);
    }
  });

  it.each([
    ["body fingerprint", (metadata: Record<string, any>) => {
      metadata.sourceGeneratedCase.contentFingerprint = "b".repeat(64);
      metadata.sourceGeneratedCase.provenance.contentFingerprint = "b".repeat(64);
    }],
    ["GeneratedCase id", (metadata: Record<string, any>) => { metadata.sourceGeneratedCase.id = "other-case"; }],
    ["unknown source review", (metadata: Record<string, any>) => { metadata.source.reviewFingerprint = "c".repeat(64); }],
    ["fixedCaseId", (metadata: Record<string, any>) => { metadata.fixedCaseId = "other-id"; }],
    ["metadata format", (metadata: Record<string, any>) => { metadata.format = "unknown-format"; }],
    ["metadata version", (metadata: Record<string, any>) => { metadata.version = 99; }],
  ] as const)("refuse une metadata de promotion corrompue: %s", async (_label, mutate) => {
    const fixture = await createReviewFixture();
    try {
      await review(fixture);
      const result = await promote(fixture);
      const metadata = JSON.parse(await fs.readFile(result.metadataPath, "utf8")) as Record<string, any>;
      mutate(metadata);
      await fs.writeFile(result.metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
      await expect(discoverFixedBenchmarks(fixture.benchmarksDir, [promptFor(fixture)])).rejects.toThrow();
    } finally {
      await removeReviewFixture(fixture);
    }
  });
});
