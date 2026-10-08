import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import {
  parseHumanReviewStatus,
  transitionHumanReview,
  type ExperimentRun,
  type HumanReviewStatus,
} from "../domain/index.js";
import { writeOnceCanonicalJson } from "../evidence/blob-store.js";
import {
  EVIDENCE_STORE_FORMAT,
  EVIDENCE_STORE_VERSION,
  type AttemptManifestRecord,
} from "../evidence/schema.js";
import type { FilesystemEvidenceStore } from "../evidence/filesystem-evidence-store.js";
import { canonicalJson, sha256Canonical } from "../experiment/canonical-json.js";
import type { ExperimentExecutionPlan, PlannedRun } from "../experiment/plan.js";
import type { HumanReviewAuditRecord, CurrentHumanReview } from "./schema.js";

const REVIEW_FILE = /^(\d{8,})\.json$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface ReviewSource {
  readonly plan: ExperimentExecutionPlan;
  readonly plannedRun: PlannedRun;
  readonly attempt: number;
  readonly manifest: AttemptManifestRecord;
  readonly manifestRef: string;
  readonly manifestFingerprint: string;
}

export interface HumanReviewActionInput {
  readonly store: FilesystemEvidenceStore;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
  readonly status: HumanReviewStatus;
  readonly reviewer: string;
  readonly reviewedAt?: string;
  readonly now?: () => Date;
  readonly comment?: string;
}

export interface ReadHumanReviewInput {
  readonly store: FilesystemEvidenceStore;
  readonly planFingerprint: string;
  readonly plannedRunId: string;
}

function runDirectoryName(plannedRunId: string): string {
  return Buffer.from(plannedRunId, "utf8").toString("base64url");
}

export function humanReviewRecordRef(
  planFingerprint: string,
  plannedRunId: string,
  sequence: number,
): string {
  if (!SHA256.test(planFingerprint)) throw new TypeError("planFingerprint must be SHA-256");
  if (typeof plannedRunId !== "string" || plannedRunId.length === 0) {
    throw new TypeError("plannedRunId must be a non-empty string");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError("review sequence must be a positive integer");
  }
  return `plans/${planFingerprint}/reviews/${runDirectoryName(plannedRunId)}/${String(sequence).padStart(8, "0")}.json`;
}

function reviewDirectory(store: FilesystemEvidenceStore, planFingerprint: string, plannedRunId: string): string {
  return path.join(store.root, "plans", planFingerprint, "reviews", runDirectoryName(plannedRunId));
}

function recordWithoutFingerprint(record: HumanReviewAuditRecord): Omit<HumanReviewAuditRecord, "recordFingerprint"> {
  const { recordFingerprint: _fingerprint, ...content } = record;
  return content;
}

export function humanReviewRecordFingerprint(record: HumanReviewAuditRecord): string {
  return sha256Canonical(recordWithoutFingerprint(record));
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

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`);
  return value as number;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) throw new TypeError(`${field}.${key} is not supported`);
  }
}

async function resolveReviewSource(input: ReadHumanReviewInput): Promise<ReviewSource> {
  const plan = await input.store.readPlan(input.planFingerprint);
  const plannedRun = plan.plannedRuns.find(({ id }) => id === input.plannedRunId);
  if (!plannedRun) throw new Error(`unknown PlannedRun ${input.plannedRunId}`);
  const latest = await input.store.readLatestCheckpoint(plan.fingerprint);
  if (!latest.checkpoint) throw new Error("human review requires a durable experiment checkpoint");
  const logicalRun = latest.checkpoint.state.runs.find(({ plannedRunId }) => plannedRunId === plannedRun.id);
  if (!logicalRun) throw new Error(`checkpoint has no logical run ${plannedRun.id}`);
  if (logicalRun.run.technicalStatus !== "completed" && logicalRun.run.technicalStatus !== "failed") {
    throw new Error("human review requires a terminal completed or failed run");
  }
  const attempt = await input.store.readAttempt(plan.fingerprint, plannedRun.id, logicalRun.attempt);
  if (attempt.summary.status !== "finalized" || !attempt.manifest || !attempt.summary.manifestRef) {
    throw new Error("human review requires a finalized attempt manifest");
  }
  if (
    attempt.manifest.plannedRunId !== plannedRun.id
    || attempt.manifest.attempt !== logicalRun.attempt
    || canonicalJson(attempt.manifest.experimentRun) !== canonicalJson(logicalRun.run)
  ) {
    throw new Error("finalized attempt differs from the current logical run");
  }
  return {
    plan,
    plannedRun,
    attempt: logicalRun.attempt,
    manifest: attempt.manifest,
    manifestRef: attempt.summary.manifestRef,
    manifestFingerprint: sha256Canonical(attempt.manifest),
  };
}

function validateReviewRecord(
  value: unknown,
  expectedSequence: number,
  previousStatus: HumanReviewStatus,
  source: ReviewSource,
): HumanReviewAuditRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("human review record must be an object");
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, [
    "format", "version", "kind", "sequence", "recordFingerprint", "planId", "planFingerprint",
    "plannedRunId", "attempt", "experimentId", "promptVersionId", "testCaseId", "variant", "repetition",
    "sourceAttemptRef", "sourceAttemptFingerprint", "previousStatus", "status", "reviewer", "reviewedAt", "comment",
  ], "humanReview");
  if (
    record.format !== EVIDENCE_STORE_FORMAT
    || record.version !== EVIDENCE_STORE_VERSION
    || record.kind !== "human-review"
  ) {
    throw new Error("invalid human review format, version or kind");
  }
  const sequence = positiveInteger(record.sequence, "humanReview.sequence");
  if (sequence !== expectedSequence) throw new Error("human review sequence is not contiguous");
  const status = parseHumanReviewStatus(record.status);
  const parsedPrevious = parseHumanReviewStatus(record.previousStatus);
  if (parsedPrevious !== previousStatus) throw new Error("human review previousStatus is inconsistent");
  const reviewer = nonEmpty(record.reviewer, "humanReview.reviewer");
  const reviewedAt = isoTimestamp(record.reviewedAt, "humanReview.reviewedAt");
  const comment = record.comment === undefined ? undefined : nonEmpty(record.comment, "humanReview.comment");
  if (
    record.planId !== source.plan.id
    || record.planFingerprint !== source.plan.fingerprint
    || record.plannedRunId !== source.plannedRun.id
    || record.attempt !== source.attempt
    || record.experimentId !== source.plannedRun.experimentId
    || record.promptVersionId !== source.plannedRun.promptVersionId
    || record.testCaseId !== source.plannedRun.testCaseId
    || record.variant !== source.plannedRun.variant
    || record.repetition !== source.plannedRun.repetition
    || record.sourceAttemptRef !== source.manifestRef
    || record.sourceAttemptFingerprint !== source.manifestFingerprint
  ) {
    throw new Error("human review source does not match its finalized attempt manifest");
  }
  const fingerprint = nonEmpty(record.recordFingerprint, "humanReview.recordFingerprint");
  if (!SHA256.test(fingerprint)) throw new TypeError("humanReview.recordFingerprint must be SHA-256");
  const parsed: HumanReviewAuditRecord = {
    format: EVIDENCE_STORE_FORMAT,
    version: EVIDENCE_STORE_VERSION,
    kind: "human-review",
    sequence,
    recordFingerprint: fingerprint,
    planId: source.plan.id,
    planFingerprint: source.plan.fingerprint,
    plannedRunId: source.plannedRun.id,
    attempt: source.attempt,
    experimentId: source.plannedRun.experimentId,
    promptVersionId: source.plannedRun.promptVersionId,
    testCaseId: source.plannedRun.testCaseId,
    variant: source.plannedRun.variant,
    repetition: source.plannedRun.repetition,
    sourceAttemptRef: source.manifestRef,
    sourceAttemptFingerprint: source.manifestFingerprint,
    previousStatus: parsedPrevious,
    status,
    reviewer,
    reviewedAt,
    ...(comment === undefined ? {} : { comment }),
  };
  if (humanReviewRecordFingerprint(parsed) !== fingerprint) {
    throw new Error("human review record fingerprint is invalid");
  }
  return parsed;
}

export async function readHumanReviewHistory(
  input: ReadHumanReviewInput,
): Promise<readonly HumanReviewAuditRecord[]> {
  const source = await resolveReviewSource(input);
  const directory = reviewDirectory(input.store, input.planFingerprint, input.plannedRunId);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates: Array<{ name: string; sequence: number }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".tmp-")) continue;
    const match = REVIEW_FILE.exec(entry.name);
    if (!entry.isFile() || !match) throw new Error(`invalid human review journal entry: ${entry.name}`);
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`invalid human review sequence: ${entry.name}`);
    candidates.push({ name: entry.name, sequence });
  }
  candidates.sort((left, right) => left.sequence - right.sequence);
  const history: HumanReviewAuditRecord[] = [];
  let currentStatus: HumanReviewStatus = "pending_review";
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const expectedSequence = index + 1;
    if (candidate.sequence !== expectedSequence) throw new Error("human review journal sequence is not contiguous");
    const parsed = JSON.parse(await fs.readFile(path.join(directory, candidate.name), "utf8")) as unknown;
    const record = validateReviewRecord(parsed, expectedSequence, currentStatus, source);
    history.push(record);
    currentStatus = record.status;
  }
  return history;
}

export async function readCurrentHumanReview(input: ReadHumanReviewInput): Promise<CurrentHumanReview> {
  const history = await readHumanReviewHistory(input);
  const latest = history.at(-1) ?? null;
  return { status: latest?.status ?? "pending_review", latest };
}

export async function readReviewedRun(input: ReadHumanReviewInput): Promise<ExperimentRun> {
  const source = await resolveReviewSource(input);
  const history = await readHumanReviewHistory(input);
  return history.reduce<ExperimentRun>((run, review) => transitionHumanReview(run, {
    status: review.status,
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    ...(review.comment === undefined ? {} : { comment: review.comment }),
  }), source.manifest.experimentRun);
}

export async function recordHumanReview(
  input: HumanReviewActionInput,
): Promise<HumanReviewAuditRecord> {
  const source = await resolveReviewSource(input);
  const history = await readHumanReviewHistory(input);
  const previousStatus = history.at(-1)?.status ?? "pending_review";
  const reviewedAt = isoTimestamp(input.reviewedAt ?? (input.now ?? (() => new Date()))().toISOString(), "reviewedAt");
  const reviewer = nonEmpty(input.reviewer, "reviewer");
  const status = parseHumanReviewStatus(input.status);
  const comment = input.comment === undefined ? undefined : nonEmpty(input.comment, "comment");
  transitionHumanReview(source.manifest.experimentRun, {
    status,
    reviewer,
    reviewedAt,
    ...(comment === undefined ? {} : { comment }),
  });
  const content = {
    format: EVIDENCE_STORE_FORMAT as typeof EVIDENCE_STORE_FORMAT,
    version: EVIDENCE_STORE_VERSION as typeof EVIDENCE_STORE_VERSION,
    kind: "human-review" as const,
    sequence: history.length + 1,
    planId: source.plan.id,
    planFingerprint: source.plan.fingerprint,
    plannedRunId: source.plannedRun.id,
    attempt: source.attempt,
    experimentId: source.plannedRun.experimentId,
    promptVersionId: source.plannedRun.promptVersionId,
    testCaseId: source.plannedRun.testCaseId,
    variant: source.plannedRun.variant,
    repetition: source.plannedRun.repetition,
    sourceAttemptRef: source.manifestRef,
    sourceAttemptFingerprint: source.manifestFingerprint,
    previousStatus,
    status,
    reviewer,
    reviewedAt,
    ...(comment === undefined ? {} : { comment }),
  };
  const record: HumanReviewAuditRecord = {
    ...content,
    recordFingerprint: sha256Canonical(content),
  };
  input.store.assertPortable(record);
  const directory = reviewDirectory(input.store, input.planFingerprint, input.plannedRunId);
  const filename = path.posix.basename(humanReviewRecordRef(
    input.planFingerprint,
    input.plannedRunId,
    record.sequence,
  ));
  await writeOnceCanonicalJson(path.join(directory, filename), record, `human review ${record.sequence}`);
  return record;
}
