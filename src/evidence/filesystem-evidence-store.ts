import fs from "node:fs/promises";
import path from "node:path";

import { createExperimentExecutionPlan, type ExperimentExecutionPlan } from "../experiment/plan.js";
import { canonicalJson, sha256Canonical } from "../experiment/canonical-json.js";
import type { ExperimentExecutionState } from "../experiment/orchestrator.js";
import { ContentAddressedBlobStore, writeOnceCanonicalJson } from "./blob-store.js";
import {
  EVIDENCE_STORE_FORMAT,
  EVIDENCE_STORE_VERSION,
  type ArtifactReference,
  type AttemptManifestRecord,
  type AttemptStartedRecord,
  type LatestCheckpointResult,
  type RunAttemptSummary,
  type StoredCheckpointRecord,
  type StoredPlanRecord,
  type StoredRunAttempt,
  type StoreFormatRecord,
} from "./schema.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHECKPOINT_PATTERN = /^(\d{8})\.json$/;
const ATTEMPT_PATTERN = /^attempt-(\d{4})$/;

function assertFingerprint(value: string, pathName: string): void {
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${pathName} must be a SHA-256 fingerprint`);
}

function assertPositiveInteger(value: number, pathName: string): void {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${pathName} must be a positive integer`);
}

function runDirectoryName(plannedRunId: string): string {
  if (typeof plannedRunId !== "string" || plannedRunId.length === 0) throw new TypeError("plannedRunId is required");
  return Buffer.from(plannedRunId, "utf8").toString("base64url");
}

function attemptDirectoryName(attempt: number): string {
  assertPositiveInteger(attempt, "attempt");
  return `attempt-${String(attempt).padStart(4, "0")}`;
}

function checkpointFilename(sequence: number): string {
  assertPositiveInteger(sequence, "checkpoint sequence");
  return `${String(sequence).padStart(8, "0")}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertHeader(value: unknown, kind: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${kind} record must be an object`);
  if (value.format !== EVIDENCE_STORE_FORMAT || value.version !== EVIDENCE_STORE_VERSION || value.kind !== kind) {
    throw new Error(`invalid ${kind} format, version or kind`);
  }
}

function portableState(state: ExperimentExecutionState): ExperimentExecutionState {
  return {
    planId: state.planId,
    planFingerprint: state.planFingerprint,
    status: state.status,
    ...(state.baseline === undefined ? {} : { baseline: state.baseline }),
    runs: state.runs.map(({ facts: _facts, ...logicalRun }) => logicalRun),
    events: state.events,
  };
}

function normalizedPathText(value: string): string {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function inspectStrings(value: unknown, callback: (entry: string) => void): void {
  if (typeof value === "string") {
    callback(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => inspectStrings(entry, callback));
    return;
  }
  if (!isRecord(value)) return;
  Object.values(value).forEach((entry) => inspectStrings(entry, callback));
}

export class FilesystemEvidenceStore {
  readonly root: string;
  readonly blobs: ContentAddressedBlobStore;

  constructor(root: string) {
    if (typeof root !== "string" || root.trim() === "") throw new TypeError("evidence store root must be explicit");
    this.root = path.resolve(root);
    this.blobs = new ContentAddressedBlobStore(this.root);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const record: StoreFormatRecord = {
      format: EVIDENCE_STORE_FORMAT,
      version: EVIDENCE_STORE_VERSION,
      kind: "store",
    };
    await writeOnceCanonicalJson(path.join(this.root, "format.json"), record, "evidence store format");
  }

  assertPortable(value: unknown, forbiddenAbsolutePaths: readonly string[] = []): void {
    const forbidden = [this.root, ...forbiddenAbsolutePaths]
      .filter((entry) => typeof entry === "string" && entry.trim() !== "")
      .map(normalizedPathText);
    inspectStrings(value, (entry) => {
      const normalized = entry.replaceAll("\\", "/");
      const comparable = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      for (const forbiddenPath of forbidden) {
        if (comparable.includes(forbiddenPath)) throw new Error("reviewer evidence contains a forbidden host path");
      }
    });
  }

  async putArtifact(
    value: string | Uint8Array,
    mediaType: string,
    forbiddenAbsolutePaths: readonly string[] = [],
  ): Promise<ArtifactReference> {
    if (typeof value === "string") this.assertPortable(value, forbiddenAbsolutePaths);
    return this.blobs.put(value, mediaType);
  }

  async readArtifact(reference: ArtifactReference | string): Promise<Buffer> {
    return this.blobs.read(reference);
  }

  async writePlan(plan: ExperimentExecutionPlan, forbiddenAbsolutePaths: readonly string[] = []): Promise<void> {
    assertFingerprint(plan.fingerprint, "plan.fingerprint");
    const recreated = createExperimentExecutionPlan({ id: plan.id, experiments: plan.experiments });
    if (canonicalJson(recreated) !== canonicalJson(plan)) {
      throw new Error("plan content does not match its canonical fingerprint and PlannedRuns");
    }
    const record: StoredPlanRecord = {
      format: EVIDENCE_STORE_FORMAT,
      version: EVIDENCE_STORE_VERSION,
      kind: "plan",
      planFingerprint: plan.fingerprint,
      plan,
    };
    this.assertPortable(record, forbiddenAbsolutePaths);
    await writeOnceCanonicalJson(this.planPath(plan.fingerprint), record, `plan ${plan.fingerprint}`);
  }

  async readPlan(planFingerprint: string): Promise<ExperimentExecutionPlan> {
    assertFingerprint(planFingerprint, "planFingerprint");
    const parsed = JSON.parse(await fs.readFile(this.planPath(planFingerprint), "utf8")) as unknown;
    assertHeader(parsed, "plan");
    if (parsed.planFingerprint !== planFingerprint || !isRecord(parsed.plan)) {
      throw new Error("stored plan does not match requested fingerprint");
    }
    const rawPlan = parsed.plan as unknown as ExperimentExecutionPlan;
    const recreated = createExperimentExecutionPlan({ id: rawPlan.id, experiments: rawPlan.experiments });
    if (recreated.fingerprint !== planFingerprint || canonicalJson(recreated) !== canonicalJson(rawPlan)) {
      throw new Error("stored plan content is inconsistent with its fingerprint");
    }
    return recreated;
  }

  async appendCheckpoint(
    plan: ExperimentExecutionPlan,
    state: ExperimentExecutionState,
    forbiddenAbsolutePaths: readonly string[] = [],
  ): Promise<StoredCheckpointRecord> {
    if (state.planId !== plan.id || state.planFingerprint !== plan.fingerprint) {
      throw new Error("checkpoint state does not reference the supplied plan");
    }
    const portable = portableState(state);
    const directory = this.checkpointDirectory(plan.fingerprint);
    await fs.mkdir(directory, { recursive: true });
    const entries = await fs.readdir(directory);
    const sequence = entries.reduce((highest, entry) => {
      const match = CHECKPOINT_PATTERN.exec(entry);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    const record: StoredCheckpointRecord = {
      format: EVIDENCE_STORE_FORMAT,
      version: EVIDENCE_STORE_VERSION,
      kind: "checkpoint",
      sequence,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      stateFingerprint: sha256Canonical(portable),
      state: portable,
    };
    this.assertPortable(record, forbiddenAbsolutePaths);
    await writeOnceCanonicalJson(
      path.join(directory, checkpointFilename(sequence)),
      record,
      `checkpoint ${sequence}`,
    );
    return record;
  }

  async readLatestCheckpoint(planFingerprint: string): Promise<LatestCheckpointResult> {
    const plan = await this.readPlan(planFingerprint);
    const directory = this.checkpointDirectory(planFingerprint);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { checkpoint: null, invalidCheckpointRefs: [] };
      }
      throw error;
    }
    const candidates = entries
      .filter((entry) => CHECKPOINT_PATTERN.test(entry))
      .sort()
      .reverse();
    const invalidCheckpointRefs: string[] = [];
    for (const entry of candidates) {
      const ref = `plans/${planFingerprint}/checkpoints/${entry}`;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as unknown;
        assertHeader(parsed, "checkpoint");
        const sequence = Number(CHECKPOINT_PATTERN.exec(entry)![1]);
        if (
          parsed.sequence !== sequence
          || parsed.planId !== plan.id
          || parsed.planFingerprint !== planFingerprint
          || !isRecord(parsed.state)
          || parsed.stateFingerprint !== sha256Canonical(parsed.state)
        ) {
          throw new Error("checkpoint metadata or content fingerprint is invalid");
        }
        return { checkpoint: parsed as unknown as StoredCheckpointRecord, invalidCheckpointRefs };
      } catch {
        invalidCheckpointRefs.push(ref);
      }
    }
    return { checkpoint: null, invalidCheckpointRefs };
  }

  async writeAttemptStarted(record: AttemptStartedRecord, forbiddenAbsolutePaths: readonly string[] = []): Promise<void> {
    this.assertAttemptIdentity(record);
    this.assertPortable(record, forbiddenAbsolutePaths);
    await writeOnceCanonicalJson(
      this.attemptFile(record.planFingerprint, record.plannedRunId, record.attempt, "started.json"),
      record,
      `started attempt ${record.plannedRunId}/${record.attempt}`,
    );
  }

  async finalizeAttempt(record: AttemptManifestRecord, forbiddenAbsolutePaths: readonly string[] = []): Promise<void> {
    this.assertAttemptIdentity(record);
    this.assertPortable(record, forbiddenAbsolutePaths);
    const started = await this.readAttemptStarted(record.planFingerprint, record.plannedRunId, record.attempt);
    if (
      started.planId !== record.planId
      || started.planFingerprint !== record.planFingerprint
      || started.plannedRunId !== record.plannedRunId
      || started.attempt !== record.attempt
      || started.modelInput.sha256 !== record.artifacts.modelInput.sha256
    ) {
      throw new Error("attempt manifest does not match its immutable started record");
    }
    await writeOnceCanonicalJson(
      this.attemptFile(record.planFingerprint, record.plannedRunId, record.attempt, "manifest.json"),
      record,
      `manifest attempt ${record.plannedRunId}/${record.attempt}`,
    );
  }

  async listRunAttempts(planFingerprint: string, plannedRunId: string): Promise<readonly RunAttemptSummary[]> {
    assertFingerprint(planFingerprint, "planFingerprint");
    const directory = this.runPath(planFingerprint, plannedRunId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: RunAttemptSummary[] = [];
    for (const entry of entries.sort()) {
      const match = ATTEMPT_PATTERN.exec(entry);
      if (!match) continue;
      const attempt = Number(match[1]);
      const startedPath = path.join(directory, entry, "started.json");
      try {
        await fs.access(startedPath);
      } catch {
        continue;
      }
      const manifestPath = path.join(directory, entry, "manifest.json");
      let finalized = true;
      try {
        await fs.access(manifestPath);
      } catch {
        finalized = false;
      }
      const prefix = `plans/${planFingerprint}/runs/${runDirectoryName(plannedRunId)}/${entry}`;
      summaries.push({
        attempt,
        status: finalized ? "finalized" : "partial",
        startedRef: `${prefix}/started.json`,
        manifestRef: finalized ? `${prefix}/manifest.json` : null,
      });
    }
    return summaries;
  }

  async readAttempt(planFingerprint: string, plannedRunId: string, attempt: number): Promise<StoredRunAttempt> {
    const summary = (await this.listRunAttempts(planFingerprint, plannedRunId))
      .find((candidate) => candidate.attempt === attempt);
    if (!summary) throw new Error(`unknown attempt ${plannedRunId}/${attempt}`);
    const started = await this.readAttemptStarted(planFingerprint, plannedRunId, attempt);
    const manifest = summary.manifestRef
      ? await this.readJsonFile<AttemptManifestRecord>(
          this.attemptFile(planFingerprint, plannedRunId, attempt, "manifest.json"),
          "attempt-manifest",
        )
      : null;
    return { summary, started, manifest };
  }

  private planDirectory(planFingerprint: string): string {
    assertFingerprint(planFingerprint, "planFingerprint");
    return path.join(this.root, "plans", planFingerprint);
  }

  private planPath(planFingerprint: string): string {
    return path.join(this.planDirectory(planFingerprint), "plan.json");
  }

  private checkpointDirectory(planFingerprint: string): string {
    return path.join(this.planDirectory(planFingerprint), "checkpoints");
  }

  private runPath(planFingerprint: string, plannedRunId: string): string {
    return path.join(this.planDirectory(planFingerprint), "runs", runDirectoryName(plannedRunId));
  }

  private attemptFile(
    planFingerprint: string,
    plannedRunId: string,
    attempt: number,
    filename: "started.json" | "manifest.json",
  ): string {
    return path.join(this.runPath(planFingerprint, plannedRunId), attemptDirectoryName(attempt), filename);
  }

  private assertAttemptIdentity(record: AttemptStartedRecord | AttemptManifestRecord): void {
    assertFingerprint(record.planFingerprint, "attempt.planFingerprint");
    assertPositiveInteger(record.attempt, "attempt.attempt");
    if (typeof record.plannedRunId !== "string" || record.plannedRunId.length === 0) {
      throw new TypeError("attempt.plannedRunId is required");
    }
  }

  private async readAttemptStarted(
    planFingerprint: string,
    plannedRunId: string,
    attempt: number,
  ): Promise<AttemptStartedRecord> {
    return this.readJsonFile<AttemptStartedRecord>(
      this.attemptFile(planFingerprint, plannedRunId, attempt, "started.json"),
      "attempt-started",
    );
  }

  private async readJsonFile<T>(filename: string, kind: string): Promise<T> {
    const parsed = JSON.parse(await fs.readFile(filename, "utf8")) as unknown;
    assertHeader(parsed, kind);
    return parsed as T;
  }
}

export async function openEvidenceStore(root: string): Promise<FilesystemEvidenceStore> {
  const store = new FilesystemEvidenceStore(root);
  await store.initialize();
  return store;
}
