import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createTestCase, parseHumanReviewStatus, type FixedCase } from "../domain/index.js";
import { EVIDENCE_STORE_FORMAT, EVIDENCE_STORE_VERSION } from "../evidence/schema.js";
import { sha256Exact } from "../experiment/canonical-json.js";
import { humanReviewRecordFingerprint } from "../review/human-review.js";
import {
  PROMOTED_BENCHMARK_FORMAT,
  PROMOTION_METADATA_FORMAT,
  PROMOTION_METADATA_VERSION,
  type FixedBenchmarkPromotionMetadata,
  type HumanReviewAuditRecord,
} from "../review/schema.js";
import type { DiscoveredPrompt } from "./prompt-discovery.js";

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTATIONS = ["implementation", "clarification"] as const;

export type FixedBenchmarkExpectation = (typeof EXPECTATIONS)[number];

export interface FixedBenchmarkDefinition {
  readonly id: string;
  readonly testCase: FixedCase;
  readonly promptDefinitionId: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sourceFingerprint: string;
  readonly expectation: FixedBenchmarkExpectation;
  readonly promotion?: FixedBenchmarkPromotionMetadata;
}

interface ParsedBenchmark {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/").replaceAll("\\", "/");
}

function parseBenchmark(markdown: string, sourcePath: string): ParsedBenchmark {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) throw new Error(`Frontmatter benchmark mal formé : ${sourcePath}`);
  const fields: Record<string, string> = {};
  const allowed = new Set(["format", "id", "prompt", "title", "expectation"]);
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!entry) throw new Error(`Frontmatter benchmark mal formé (${sourcePath}) : ${line}`);
    const key = entry[1]!.toLowerCase();
    if (!allowed.has(key)) throw new Error(`Champ benchmark inconnu (${sourcePath}) : ${key}`);
    if (Object.hasOwn(fields, key)) throw new Error(`Champ benchmark dupliqué (${sourcePath}) : ${key}`);
    fields[key] = entry[2]!;
  }
  if (fields.format !== "codex-lab-benchmark" && fields.format !== PROMOTED_BENCHMARK_FORMAT) {
    throw new Error(`Format benchmark incorrect (${sourcePath}) : ${fields.format || "(vide)"}`);
  }
  const rawBody = markdown.slice(match[0].length);
  return { fields, body: fields.format === PROMOTED_BENCHMARK_FORMAT ? rawBody : rawBody.trim() };
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError(`${field}.${key} is not supported`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`);
  return value as number;
}

function sha256Fingerprint(value: unknown, field: string): string {
  const fingerprint = requiredString(value, field);
  if (!SHA256.test(fingerprint)) throw new TypeError(`${field} must be a SHA-256 fingerprint`);
  return fingerprint;
}

function timestamp(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  }
  return result;
}

function validateEmbeddedReview(value: unknown, field: string): HumanReviewAuditRecord {
  const raw = objectRecord(value, field);
  exactKeys(raw, [
    "format", "version", "kind", "sequence", "recordFingerprint", "planId", "planFingerprint",
    "plannedRunId", "attempt", "experimentId", "promptVersionId", "testCaseId", "variant", "repetition",
    "sourceAttemptRef", "sourceAttemptFingerprint", "previousStatus", "status", "reviewer", "reviewedAt", "comment",
  ], field);
  const review = raw as unknown as HumanReviewAuditRecord;
  if (review.format !== EVIDENCE_STORE_FORMAT || review.version !== EVIDENCE_STORE_VERSION || review.kind !== "human-review") {
    throw new Error(`${field} has an invalid format, version or kind`);
  }
  positiveInteger(review.sequence, `${field}.sequence`);
  positiveInteger(review.attempt, `${field}.attempt`);
  positiveInteger(review.repetition, `${field}.repetition`);
  for (const key of ["planId", "plannedRunId", "experimentId", "promptVersionId", "testCaseId", "sourceAttemptRef", "reviewer"] as const) {
    requiredString(review[key], `${field}.${key}`);
  }
  sha256Fingerprint(review.planFingerprint, `${field}.planFingerprint`);
  sha256Fingerprint(review.sourceAttemptFingerprint, `${field}.sourceAttemptFingerprint`);
  sha256Fingerprint(review.recordFingerprint, `${field}.recordFingerprint`);
  if (review.variant !== "baseline" && review.variant !== "treatment") throw new TypeError(`${field}.variant is invalid`);
  parseHumanReviewStatus(review.previousStatus);
  parseHumanReviewStatus(review.status);
  timestamp(review.reviewedAt, `${field}.reviewedAt`);
  if (review.comment !== undefined) requiredString(review.comment, `${field}.comment`);
  if (humanReviewRecordFingerprint(review) !== review.recordFingerprint) {
    throw new Error(`${field} fingerprint is invalid`);
  }
  if (review.status === "pending_review") throw new Error(`${field} must contain a non-pending decision`);
  return review;
}

async function readPromotionMetadata(input: {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}): Promise<FixedBenchmarkPromotionMetadata> {
  const metadataPath = input.sourcePath.replace(/\.md$/i, ".promotion.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(metadataPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Metadata de promotion manquante : ${input.relativePath}`);
    }
    throw error;
  }
  const metadata = objectRecord(parsed, "promotionMetadata");
  exactKeys(metadata, [
    "format", "version", "fixedCaseId", "promptDefinitionId", "expectation",
    "sourceGeneratedCase", "source", "promotion",
  ], "promotionMetadata");
  if (metadata.format !== PROMOTION_METADATA_FORMAT || metadata.version !== PROMOTION_METADATA_VERSION) {
    throw new Error(`Format/version metadata promotion invalide : ${input.relativePath}`);
  }
  if (
    metadata.fixedCaseId !== input.fields.id
    || metadata.promptDefinitionId !== input.fields.prompt
    || metadata.expectation !== input.fields.expectation
  ) {
    throw new Error(`Metadata promotion incohérente avec le frontmatter : ${input.relativePath}`);
  }
  const sourceCase = objectRecord(metadata.sourceGeneratedCase, "promotionMetadata.sourceGeneratedCase");
  exactKeys(sourceCase, ["id", "title", "contentFingerprint", "provenance"], "promotionMetadata.sourceGeneratedCase");
  const contentFingerprint = sha256Fingerprint(sourceCase.contentFingerprint, "sourceGeneratedCase.contentFingerprint");
  const generated = createTestCase({
    kind: "generated",
    id: requiredString(sourceCase.id, "sourceGeneratedCase.id"),
    title: requiredString(sourceCase.title, "sourceGeneratedCase.title"),
    input: input.body,
    provenance: sourceCase.provenance,
  });
  if (
    generated.kind !== "generated"
    || sha256Exact(input.body) !== contentFingerprint
    || generated.provenance.contentFingerprint !== contentFingerprint
  ) {
    throw new Error(`Fingerprint du body promu incohérent : ${input.relativePath}`);
  }
  const source = objectRecord(metadata.source, "promotionMetadata.source");
  exactKeys(source, [
    "planId", "planFingerprint", "plannedRunId", "attempt", "sourceAttemptRef",
    "sourceAttemptFingerprint", "reviewSequence", "reviewFingerprint", "review",
  ], "promotionMetadata.source");
  const review = validateEmbeddedReview(source.review, "promotionMetadata.source.review");
  requiredString(source.planId, "promotionMetadata.source.planId");
  sha256Fingerprint(source.planFingerprint, "promotionMetadata.source.planFingerprint");
  requiredString(source.plannedRunId, "promotionMetadata.source.plannedRunId");
  requiredString(source.sourceAttemptRef, "promotionMetadata.source.sourceAttemptRef");
  sha256Fingerprint(source.sourceAttemptFingerprint, "promotionMetadata.source.sourceAttemptFingerprint");
  sha256Fingerprint(source.reviewFingerprint, "promotionMetadata.source.reviewFingerprint");
  if (
    generated.id !== review.testCaseId
    ||
    source.planId !== review.planId
    || source.planFingerprint !== review.planFingerprint
    || source.plannedRunId !== review.plannedRunId
    || source.attempt !== review.attempt
    || source.sourceAttemptRef !== review.sourceAttemptRef
    || source.sourceAttemptFingerprint !== review.sourceAttemptFingerprint
    || source.reviewSequence !== review.sequence
    || source.reviewFingerprint !== review.recordFingerprint
  ) {
    throw new Error(`Source review de promotion inconnue ou incohérente : ${input.relativePath}`);
  }
  positiveInteger(source.attempt, "promotionMetadata.source.attempt");
  positiveInteger(source.reviewSequence, "promotionMetadata.source.reviewSequence");
  const promotion = objectRecord(metadata.promotion, "promotionMetadata.promotion");
  exactKeys(promotion, ["promotedBy", "promotedAt", "comment"], "promotionMetadata.promotion");
  requiredString(promotion.promotedBy, "promotion.promotedBy");
  const promotedAt = timestamp(promotion.promotedAt, "promotion.promotedAt");
  if (promotion.comment !== undefined) requiredString(promotion.comment, "promotion.comment");
  return {
    format: PROMOTION_METADATA_FORMAT,
    version: PROMOTION_METADATA_VERSION,
    fixedCaseId: input.fields.id!,
    promptDefinitionId: input.fields.prompt!,
    expectation: input.fields.expectation as FixedBenchmarkExpectation,
    sourceGeneratedCase: {
      id: generated.id,
      title: generated.title,
      contentFingerprint,
      provenance: generated.provenance,
    },
    source: {
      planId: source.planId as string,
      planFingerprint: source.planFingerprint as string,
      plannedRunId: source.plannedRunId as string,
      attempt: source.attempt as number,
      sourceAttemptRef: source.sourceAttemptRef as string,
      sourceAttemptFingerprint: source.sourceAttemptFingerprint as string,
      reviewSequence: source.reviewSequence as number,
      reviewFingerprint: source.reviewFingerprint as string,
      review,
    },
    promotion: {
      promotedBy: promotion.promotedBy as string,
      promotedAt,
      ...(promotion.comment === undefined ? {} : { comment: promotion.comment as string }),
    },
  };
}

async function markdownFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort((left, right) => portablePath(path.relative(root, left)).localeCompare(
    portablePath(path.relative(root, right)),
    "en",
    { numeric: true },
  ));
}

function requiredSafeId(value: string | undefined, field: string, sourcePath: string): string {
  if (!value || !SAFE_ID.test(value)) {
    throw new Error(`${field} benchmark manquant ou invalide (${sourcePath}) : ${value || "(vide)"}`);
  }
  return value;
}

export async function discoverFixedBenchmarks(
  benchmarksDir: string,
  prompts: readonly DiscoveredPrompt[],
): Promise<readonly FixedBenchmarkDefinition[]> {
  if (typeof benchmarksDir !== "string" || benchmarksDir.trim() === "") {
    throw new TypeError("benchmarksDir must be explicitly provided");
  }
  const root = await fs.realpath(path.resolve(benchmarksDir));
  if (!(await fs.stat(root)).isDirectory()) throw new TypeError("benchmarksDir must reference a directory");
  const promptIds = new Set(prompts.map(({ definition }) => definition.id));
  const ids = new Set<string>();
  const benchmarks: FixedBenchmarkDefinition[] = [];

  for (const sourcePath of await markdownFiles(root)) {
    const markdown = await fs.readFile(sourcePath, "utf8");
    const relativePath = portablePath(path.relative(root, sourcePath));
    const { fields, body } = parseBenchmark(markdown, relativePath);
    const caseId = requiredSafeId(fields.id, "ID", relativePath);
    const promptDefinitionId = requiredSafeId(fields.prompt, "Prompt", relativePath);
    if (!promptIds.has(promptDefinitionId)) {
      throw new Error(`Prompt benchmark introuvable (${relativePath}) : ${promptDefinitionId}`);
    }
    if (!fields.title?.trim()) throw new Error(`Titre benchmark manquant : ${relativePath}`);
    if (body === "") throw new Error(`Body benchmark vide : ${relativePath}`);
    if (fields.format === PROMOTED_BENCHMARK_FORMAT && body.trim() === "") {
      throw new Error(`Body benchmark v2 vide : ${relativePath}`);
    }
    if (!EXPECTATIONS.includes(fields.expectation as FixedBenchmarkExpectation)) {
      throw new Error(`Expectation benchmark inconnue (${relativePath}) : ${fields.expectation || "(vide)"}`);
    }
    const id = `${promptDefinitionId}--benchmark-${caseId}`;
    if (ids.has(id)) throw new Error(`Benchmark dupliqué ${id} : ${relativePath}`);
    ids.add(id);
    const testCase = createTestCase({ kind: "fixed", id: caseId, title: fields.title.trim(), input: body });
    if (testCase.kind !== "fixed") throw new Error(`Type de benchmark inattendu : ${relativePath}`);
    const promotion = fields.format === PROMOTED_BENCHMARK_FORMAT
      ? await readPromotionMetadata({ sourcePath, relativePath, fields, body })
      : undefined;
    benchmarks.push({
      id,
      testCase,
      promptDefinitionId,
      sourcePath,
      relativePath,
      sourceFingerprint: sha256(markdown),
      expectation: fields.expectation as FixedBenchmarkExpectation,
      ...(promotion === undefined ? {} : { promotion }),
    });
  }
  return benchmarks;
}

export function selectFixedBenchmarks(
  benchmarks: readonly FixedBenchmarkDefinition[],
  selector?: string,
): readonly FixedBenchmarkDefinition[] {
  if (selector === undefined) return [...benchmarks];
  if (selector.trim() === "") throw new TypeError("benchmark selector must not be empty");
  const exact = benchmarks.filter(({ id }) => id === selector);
  if (exact.length === 1) return exact;
  const byPrompt = benchmarks.filter(({ promptDefinitionId }) => promptDefinitionId === selector);
  if (byPrompt.length > 0) return byPrompt;
  throw new Error(`Benchmark ou prompt introuvable : ${selector}`);
}
