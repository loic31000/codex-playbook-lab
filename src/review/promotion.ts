import fs from "node:fs/promises";
import path from "node:path";

import {
  createGenerationProvenance,
  parseHumanReviewStatus,
  type GeneratedCase,
} from "../domain/index.js";
import { writeOnceAtomic, writeOnceCanonicalJson } from "../evidence/blob-store.js";
import {
  EVIDENCE_STORE_FORMAT,
  EVIDENCE_STORE_VERSION,
  type AttemptManifestRecord,
} from "../evidence/schema.js";
import type { FilesystemEvidenceStore } from "../evidence/filesystem-evidence-store.js";
import { canonicalJson, sha256Canonical, sha256Exact } from "../experiment/canonical-json.js";
import { findPlannedRunContext, type ExperimentExecutionPlan, type PlannedRun } from "../experiment/plan.js";
import { humanReviewRecordFingerprint, readCurrentHumanReview } from "./human-review.js";
import {
  PromotionConflictError,
  PromotionIntegrityError,
  ReviewConflictError,
  ReviewNotFoundError,
} from "./errors.js";
import {
  PROMOTED_BENCHMARK_FORMAT,
  PROMOTION_METADATA_FORMAT,
  PROMOTION_METADATA_VERSION,
  type CasePromotionAuditRecord,
  type FixedBenchmarkPromotionMetadata,
  type PromotionExpectation,
  type PromotionSourceReference,
} from "./schema.js";

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTATIONS: readonly PromotionExpectation[] = ["implementation", "clarification"];

export interface PromoteGeneratedCaseInput {
  readonly store: FilesystemEvidenceStore;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly benchmarksDir: string;
  readonly fixedCaseId: string;
  readonly title: string;
  readonly expectation: PromotionExpectation;
  readonly promotedBy: string;
  readonly promotedAt?: string;
  readonly now?: () => Date;
  readonly comment?: string;
}

export interface PromotedGeneratedCaseResult {
  readonly audit: CasePromotionAuditRecord;
  readonly metadata: FixedBenchmarkPromotionMetadata;
  readonly benchmarkPath: string;
  readonly metadataPath: string;
}

interface PromotionSource {
  readonly plan: ExperimentExecutionPlan;
  readonly plannedRun: PlannedRun;
  readonly generatedCase: GeneratedCase;
  readonly manifest: AttemptManifestRecord;
  readonly source: PromotionSourceReference;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = nonEmpty(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) throw new TypeError(`${field}.${key} is not supported`);
  }
}

function sha256Fingerprint(value: unknown, field: string): string {
  const fingerprint = nonEmpty(value, field);
  if (!SHA256.test(fingerprint)) throw new TypeError(`${field} must be SHA-256`);
  return fingerprint;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`);
  return value as number;
}

function portableRelativePath(value: unknown, field: string): string {
  const result = nonEmpty(value, field);
  if (path.isAbsolute(result) || result.includes("\\") || result.split("/").includes("..")) {
    throw new TypeError(`${field} must be a portable relative path`);
  }
  return result;
}

async function exists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function markdownFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

async function assertFixedCaseIdAvailable(root: string, fixedCaseId: string): Promise<void> {
  for (const filename of await markdownFiles(root)) {
    const markdown = await fs.readFile(filename, "utf8");
    const frontmatter = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
    if (!frontmatter) continue;
    const fields = Object.fromEntries(frontmatter.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
      return match ? [[match[1]!.toLowerCase(), match[2]!]] : [];
    }));
    if (
      (fields.format === "codex-lab-benchmark" || fields.format === PROMOTED_BENCHMARK_FORMAT)
      && fields.id === fixedCaseId
    ) {
      throw new PromotionConflictError(`fixed benchmark id already exists: ${fixedCaseId}`);
    }
  }
}

async function resolvePromotionSourceData(input: PromoteGeneratedCaseInput): Promise<PromotionSource> {
  let plan: ExperimentExecutionPlan;
  try {
    plan = await input.store.readPlan(input.planFingerprint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReviewNotFoundError("promotion plan was not found");
    }
    throw error;
  }
  const plannedRun = plan.plannedRuns.find(({ id }) => id === input.plannedRunId);
  if (!plannedRun) throw new ReviewNotFoundError(`unknown PlannedRun ${input.plannedRunId}`);
  const { testCase } = findPlannedRunContext(plan, plannedRun);
  if (testCase.kind !== "generated") throw new PromotionConflictError("only a GeneratedCase can be promoted");
  const latest = await input.store.readLatestCheckpoint(plan.fingerprint);
  const logicalRun = latest.checkpoint?.state.runs.find(({ plannedRunId }) => plannedRunId === plannedRun.id);
  if (!logicalRun || (logicalRun.run.technicalStatus !== "completed" && logicalRun.run.technicalStatus !== "failed")) {
    throw new PromotionConflictError("promotion requires a terminal completed or failed run");
  }
  let attempt: Awaited<ReturnType<FilesystemEvidenceStore["readAttempt"]>>;
  try {
    attempt = await input.store.readAttempt(plan.fingerprint, plannedRun.id, logicalRun.attempt);
  } catch (error) {
    throw new PromotionIntegrityError("promotion attempt source is unavailable", { cause: error });
  }
  if (!attempt.manifest || !attempt.summary.manifestRef || attempt.summary.status !== "finalized") {
    throw new PromotionConflictError("promotion requires a finalized attempt manifest");
  }
  if (canonicalJson(attempt.manifest.experimentRun) !== canonicalJson(logicalRun.run)) {
    throw new PromotionIntegrityError("promotion attempt differs from the current logical run");
  }
  const currentReview = await readCurrentHumanReview({
    store: input.store,
    planFingerprint: plan.fingerprint,
    plannedRunId: plannedRun.id,
  });
  if (currentReview.status === "pending_review" || !currentReview.latest) {
    throw new PromotionConflictError("promotion requires an explicit non-pending human review");
  }
  const review = currentReview.latest;
  if (
    review.attempt !== logicalRun.attempt
    || review.sourceAttemptRef !== attempt.summary.manifestRef
    || review.sourceAttemptFingerprint !== sha256Canonical(attempt.manifest)
  ) {
    throw new PromotionIntegrityError("promotion review does not reference the current finalized attempt");
  }
  return {
    plan,
    plannedRun,
    generatedCase: testCase,
    manifest: attempt.manifest,
    source: {
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      plannedRunId: plannedRun.id,
      attempt: logicalRun.attempt,
      sourceAttemptRef: attempt.summary.manifestRef,
      sourceAttemptFingerprint: review.sourceAttemptFingerprint,
      reviewSequence: review.sequence,
      reviewFingerprint: review.recordFingerprint,
      review,
    },
  };
}

async function resolvePromotionSource(input: PromoteGeneratedCaseInput): Promise<PromotionSource> {
  try {
    return await resolvePromotionSourceData(input);
  } catch (error) {
    if (
      error instanceof ReviewNotFoundError
      || error instanceof ReviewConflictError
      || error instanceof PromotionConflictError
      || error instanceof PromotionIntegrityError
    ) {
      throw error;
    }
    throw new PromotionIntegrityError("promotion persisted source is invalid", { cause: error });
  }
}

function promotionAuditFingerprint(record: CasePromotionAuditRecord): string {
  const { recordFingerprint: _fingerprint, ...content } = record;
  return sha256Canonical(content);
}

export async function readCasePromotion(
  store: FilesystemEvidenceStore,
  sourceGeneratedCaseFingerprint: string,
): Promise<CasePromotionAuditRecord | null> {
  if (!/^[a-f0-9]{64}$/.test(sourceGeneratedCaseFingerprint)) {
    throw new TypeError("sourceGeneratedCaseFingerprint must be SHA-256");
  }
  const filename = path.join(store.root, "promotions", `${sourceGeneratedCaseFingerprint}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filename, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const raw = objectRecord(parsed, "casePromotion");
  exactKeys(raw, [
    "format", "version", "kind", "recordFingerprint", "sourceGeneratedCase", "source", "fixedCaseId",
    "promptDefinitionId", "expectation", "benchmarkPath", "metadataPath", "promotedBy", "promotedAt", "comment",
  ], "casePromotion");
  const record = raw as unknown as CasePromotionAuditRecord;
  if (
    record.format !== EVIDENCE_STORE_FORMAT
    || record.version !== EVIDENCE_STORE_VERSION
    || record.kind !== "case-promotion"
    || record.sourceGeneratedCase.contentFingerprint !== sourceGeneratedCaseFingerprint
    || promotionAuditFingerprint(record) !== record.recordFingerprint
  ) {
    throw new Error("case promotion audit is invalid");
  }
  if (!SAFE_ID.test(record.fixedCaseId) || !SAFE_ID.test(record.promptDefinitionId)) {
    throw new Error("case promotion audit identifiers are invalid");
  }
  if (!EXPECTATIONS.includes(record.expectation)) throw new Error("case promotion audit expectation is invalid");
  portableRelativePath(record.benchmarkPath, "casePromotion.benchmarkPath");
  portableRelativePath(record.metadataPath, "casePromotion.metadataPath");
  nonEmpty(record.promotedBy, "casePromotion.promotedBy");
  isoTimestamp(record.promotedAt, "casePromotion.promotedAt");
  if (record.comment !== undefined) nonEmpty(record.comment, "casePromotion.comment");
  const sourceCase = objectRecord(record.sourceGeneratedCase, "casePromotion.sourceGeneratedCase");
  exactKeys(sourceCase, ["id", "title", "contentFingerprint", "provenance"], "casePromotion.sourceGeneratedCase");
  nonEmpty(sourceCase.id, "casePromotion.sourceGeneratedCase.id");
  nonEmpty(sourceCase.title, "casePromotion.sourceGeneratedCase.title");
  const contentFingerprint = sha256Fingerprint(
    sourceCase.contentFingerprint,
    "casePromotion.sourceGeneratedCase.contentFingerprint",
  );
  const provenance = createGenerationProvenance(sourceCase.provenance);
  if (provenance.contentFingerprint !== contentFingerprint) throw new Error("case promotion provenance is inconsistent");
  const source = objectRecord(record.source, "casePromotion.source");
  exactKeys(source, [
    "planId", "planFingerprint", "plannedRunId", "attempt", "sourceAttemptRef", "sourceAttemptFingerprint",
    "reviewSequence", "reviewFingerprint", "review",
  ], "casePromotion.source");
  nonEmpty(source.planId, "casePromotion.source.planId");
  sha256Fingerprint(source.planFingerprint, "casePromotion.source.planFingerprint");
  nonEmpty(source.plannedRunId, "casePromotion.source.plannedRunId");
  positiveInteger(source.attempt, "casePromotion.source.attempt");
  nonEmpty(source.sourceAttemptRef, "casePromotion.source.sourceAttemptRef");
  sha256Fingerprint(source.sourceAttemptFingerprint, "casePromotion.source.sourceAttemptFingerprint");
  positiveInteger(source.reviewSequence, "casePromotion.source.reviewSequence");
  sha256Fingerprint(source.reviewFingerprint, "casePromotion.source.reviewFingerprint");
  const reviewRaw = objectRecord(source.review, "casePromotion.source.review");
  exactKeys(reviewRaw, [
    "format", "version", "kind", "sequence", "recordFingerprint", "planId", "planFingerprint",
    "plannedRunId", "attempt", "experimentId", "promptVersionId", "testCaseId", "variant", "repetition",
    "sourceAttemptRef", "sourceAttemptFingerprint", "previousStatus", "status", "reviewer", "reviewedAt", "comment",
  ], "casePromotion.source.review");
  const review = reviewRaw as unknown as PromotionSourceReference["review"];
  if (
    review.format !== EVIDENCE_STORE_FORMAT
    || review.version !== EVIDENCE_STORE_VERSION
    || review.kind !== "human-review"
    || humanReviewRecordFingerprint(review) !== review.recordFingerprint
    || review.status === "pending_review"
    || parseHumanReviewStatus(review.status) !== review.status
    || review.sequence !== source.reviewSequence
    || review.recordFingerprint !== source.reviewFingerprint
    || review.planFingerprint !== source.planFingerprint
    || review.plannedRunId !== source.plannedRunId
    || review.attempt !== source.attempt
    || review.sourceAttemptRef !== source.sourceAttemptRef
    || review.sourceAttemptFingerprint !== source.sourceAttemptFingerprint
    || review.testCaseId !== sourceCase.id
  ) {
    throw new Error("case promotion review is invalid or inconsistent");
  }
  nonEmpty(review.reviewer, "casePromotion.source.review.reviewer");
  isoTimestamp(review.reviewedAt, "casePromotion.source.review.reviewedAt");
  parseHumanReviewStatus(review.previousStatus);
  if (review.comment !== undefined) nonEmpty(review.comment, "casePromotion.source.review.comment");
  return record;
}

export async function promoteGeneratedCase(
  input: PromoteGeneratedCaseInput,
): Promise<PromotedGeneratedCaseResult> {
  if (typeof input.benchmarksDir !== "string" || input.benchmarksDir.trim() === "") {
    throw new TypeError("benchmarksDir must be explicitly provided");
  }
  if (!SAFE_ID.test(input.fixedCaseId)) throw new TypeError("fixedCaseId is invalid");
  const title = nonEmpty(input.title, "title");
  if (/[\r\n]/.test(title)) throw new TypeError("title must be a single line");
  if (!EXPECTATIONS.includes(input.expectation)) throw new TypeError("expectation must be explicit and supported");
  const promotedBy = nonEmpty(input.promotedBy, "promotedBy");
  const promotedAt = isoTimestamp(input.promotedAt ?? (input.now ?? (() => new Date()))().toISOString(), "promotedAt");
  const comment = input.comment === undefined ? undefined : nonEmpty(input.comment, "comment");
  const root = await fs.realpath(path.resolve(input.benchmarksDir));
  if (!(await fs.stat(root)).isDirectory()) throw new TypeError("benchmarksDir must reference a directory");

  const source = await resolvePromotionSource(input);
  if (!SAFE_ID.test(source.manifest.promptVersion.promptDefinitionId)) {
    throw new PromotionIntegrityError("source promptDefinitionId is invalid for a benchmark path");
  }
  let existingPromotion: CasePromotionAuditRecord | null;
  try {
    existingPromotion = await readCasePromotion(input.store, source.generatedCase.provenance.contentFingerprint);
  } catch (error) {
    throw new PromotionIntegrityError("case promotion audit is corrupt", { cause: error });
  }
  if (existingPromotion) {
    throw new PromotionConflictError("GeneratedCase already promoted");
  }
  const destinationDirectory = path.join(root, source.manifest.promptVersion.promptDefinitionId);
  const benchmarkPath = path.join(destinationDirectory, `${input.fixedCaseId}.md`);
  const metadataPath = path.join(destinationDirectory, `${input.fixedCaseId}.promotion.json`);
  const benchmarkRelativePath = path.relative(root, benchmarkPath).replaceAll("\\", "/");
  const metadataRelativePath = path.relative(root, metadataPath).replaceAll("\\", "/");
  if (path.isAbsolute(benchmarkRelativePath) || benchmarkRelativePath.startsWith("../")) {
    throw new PromotionIntegrityError("benchmark destination escapes benchmarksDir");
  }
  const benchmarkExists = await exists(benchmarkPath);
  const metadataExists = await exists(metadataPath);
  if (benchmarkExists !== metadataExists) throw new PromotionConflictError("partial promotion destination already exists");
  if (benchmarkExists || metadataExists) throw new PromotionConflictError("benchmark destination already exists");
  await assertFixedCaseIdAvailable(root, input.fixedCaseId);

  const metadata: FixedBenchmarkPromotionMetadata = {
    format: PROMOTION_METADATA_FORMAT,
    version: PROMOTION_METADATA_VERSION,
    fixedCaseId: input.fixedCaseId,
    promptDefinitionId: source.manifest.promptVersion.promptDefinitionId,
    expectation: input.expectation,
    sourceGeneratedCase: {
      id: source.generatedCase.id,
      title: source.generatedCase.title,
      contentFingerprint: source.generatedCase.provenance.contentFingerprint,
      provenance: source.generatedCase.provenance,
    },
    source: source.source,
    promotion: {
      promotedBy,
      promotedAt,
      ...(comment === undefined ? {} : { comment }),
    },
  };
  const header = [
    "---",
    `format: ${PROMOTED_BENCHMARK_FORMAT}`,
    `id: ${input.fixedCaseId}`,
    `prompt: ${metadata.promptDefinitionId}`,
    `title: ${title}`,
    `expectation: ${input.expectation}`,
    "---",
    "",
  ].join("\n");
  const markdown = header + source.generatedCase.input;
  if (markdown.slice(header.length) !== source.generatedCase.input) {
    throw new PromotionIntegrityError("promoted benchmark body construction changed the GeneratedCase input");
  }
  if (sha256Exact(source.generatedCase.input) !== source.generatedCase.provenance.contentFingerprint) {
    throw new PromotionIntegrityError("GeneratedCase input differs from its provenance fingerprint");
  }
  const auditContent = {
    format: EVIDENCE_STORE_FORMAT as typeof EVIDENCE_STORE_FORMAT,
    version: EVIDENCE_STORE_VERSION as typeof EVIDENCE_STORE_VERSION,
    kind: "case-promotion" as const,
    sourceGeneratedCase: metadata.sourceGeneratedCase,
    source: metadata.source,
    fixedCaseId: input.fixedCaseId,
    promptDefinitionId: metadata.promptDefinitionId,
    expectation: input.expectation,
    benchmarkPath: benchmarkRelativePath,
    metadataPath: metadataRelativePath,
    promotedBy,
    promotedAt,
    ...(comment === undefined ? {} : { comment }),
  };
  const audit: CasePromotionAuditRecord = {
    ...auditContent,
    recordFingerprint: sha256Canonical(auditContent),
  };
  input.store.assertPortable({ metadata, audit });

  await fs.mkdir(destinationDirectory, { recursive: true });
  await writeOnceAtomic(benchmarkPath, markdown, `promoted benchmark ${input.fixedCaseId}`);
  await writeOnceCanonicalJson(metadataPath, metadata, `promotion metadata ${input.fixedCaseId}`);
  await writeOnceCanonicalJson(
    path.join(input.store.root, "promotions", `${source.generatedCase.provenance.contentFingerprint}.json`),
    audit,
    `case promotion ${source.generatedCase.provenance.contentFingerprint}`,
  );
  return { audit, metadata, benchmarkPath, metadataPath };
}
