import fs from "node:fs/promises";
import path from "node:path";

import { parseExperimentRun } from "../domain/index.js";
import { buildExperimentModelInput } from "../experiment/model-input.js";
import {
  createExperimentExecutionPlan,
  findPlannedRunContext,
  type ExperimentExecutionPlan,
  type PlannedRun,
} from "../experiment/plan.js";
import { canonicalJson, sha256Canonical } from "../experiment/canonical-json.js";
import type { ExperimentExecutionState } from "../experiment/orchestrator.js";
import { ContentAddressedBlobStore, writeOnceCanonicalJson } from "./blob-store.js";
import {
  caseEvidenceFingerprint,
  configurationEvidenceFingerprint,
  promptEvidenceFingerprint,
  runnerEvidenceFingerprint,
  targetEvidenceFingerprint,
} from "./fingerprints.js";
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
const CHECKPOINT_PATTERN = /^(\d{8,})\.json$/;
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

function checkpointSequence(entry: string): number | null {
  const match = CHECKPOINT_PATTERN.exec(entry);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

async function regularFileExists(filename: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filename);
    if (!stats.isFile()) throw new Error(`${filename} is not a regular file`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readFileIfPresent(filename: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
    const highest = entries.reduce((current, entry) => {
      const sequence = checkpointSequence(entry);
      return sequence === null ? current : Math.max(current, sequence);
    }, 0);
    if (highest >= Number.MAX_SAFE_INTEGER) throw new Error("checkpoint sequence space is exhausted");
    const sequence = highest + 1;
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
      .map((entry) => ({ entry, sequence: checkpointSequence(entry) }))
      .filter((candidate): candidate is { entry: string; sequence: number } => candidate.sequence !== null)
      .sort((left, right) => right.sequence - left.sequence);
    const invalidCheckpointRefs: string[] = [];
    let newestValid: StoredCheckpointRecord | null = null;
    for (const { entry, sequence } of candidates) {
      const ref = `plans/${planFingerprint}/checkpoints/${entry}`;
      const bytes = await readFileIfPresent(path.join(directory, entry));
      if (bytes === null) continue;
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        assertHeader(parsed, "checkpoint");
        if (
          parsed.sequence !== sequence
          || parsed.planId !== plan.id
          || parsed.planFingerprint !== planFingerprint
          || !isRecord(parsed.state)
          || parsed.stateFingerprint !== sha256Canonical(parsed.state)
        ) {
          throw new Error("checkpoint metadata or content fingerprint is invalid");
        }
        newestValid ??= parsed as unknown as StoredCheckpointRecord;
      } catch {
        invalidCheckpointRefs.push(ref);
      }
    }
    return { checkpoint: newestValid, invalidCheckpointRefs };
  }

  async writeAttemptStarted(record: AttemptStartedRecord, forbiddenAbsolutePaths: readonly string[] = []): Promise<void> {
    this.assertAttemptIdentity(record);
    const plan = await this.readPlan(record.planFingerprint);
    await this.validateStartedAgainstPlan(plan, record);
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
    const plan = await this.readPlan(record.planFingerprint);
    await this.validateAttemptRecords(plan, started, record);
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
      if (!await regularFileExists(startedPath)) continue;
      const manifestPath = path.join(directory, entry, "manifest.json");
      const finalized = await regularFileExists(manifestPath);
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
    const plan = await this.readPlan(planFingerprint);
    await this.validateStartedAgainstPlan(plan, started);
    if (manifest) await this.validateAttemptRecords(plan, started, manifest);
    return { summary, started, manifest };
  }

  private plannedRun(plan: ExperimentExecutionPlan, plannedRunId: string): PlannedRun {
    const plannedRun = plan.plannedRuns.find(({ id }) => id === plannedRunId);
    if (!plannedRun) throw new Error(`attempt references unknown PlannedRun ${plannedRunId}`);
    return plannedRun;
  }

  private async validateStartedAgainstPlan(
    plan: ExperimentExecutionPlan,
    started: AttemptStartedRecord,
  ): Promise<void> {
    const plannedRun = this.plannedRun(plan, started.plannedRunId);
    const { experiment, testCase } = findPlannedRunContext(plan, plannedRun);
    if (
      started.planId !== plan.id
      || started.planFingerprint !== plan.fingerprint
      || started.experimentId !== plannedRun.experimentId
      || started.promptVersionId !== plannedRun.promptVersionId
      || started.testCaseId !== plannedRun.testCaseId
      || started.variant !== plannedRun.variant
      || started.repetition !== plannedRun.repetition
    ) {
      throw new Error("attempt started record differs from its immutable plan or PlannedRun");
    }
    if (canonicalJson(started.baseline.target) !== canonicalJson(plan.target)) {
      throw new Error("attempt started baseline target differs from the immutable plan");
    }
    const expectedFingerprints = {
      prompt: promptEvidenceFingerprint(experiment.promptVersion),
      testCase: caseEvidenceFingerprint(testCase),
      target: targetEvidenceFingerprint(plan.target, started.baseline),
      runner: runnerEvidenceFingerprint(started.baseline),
      plan: plan.fingerprint,
    };
    if (canonicalJson(started.fingerprints) !== canonicalJson(expectedFingerprints)) {
      throw new Error("attempt started fingerprints differ from the immutable plan or baseline");
    }
    const expectedInput = buildExperimentModelInput({
      variant: plannedRun.variant,
      promptVersion: experiment.promptVersion,
      testCase,
    });
    const storedInput = await this.readArtifact(started.modelInput);
    if (!storedInput.equals(Buffer.from(expectedInput, "utf8"))) {
      throw new Error("attempt started model input differs from its PlannedRun input");
    }
  }

  private async validateAttemptRecords(
    plan: ExperimentExecutionPlan,
    started: AttemptStartedRecord,
    manifest: AttemptManifestRecord,
  ): Promise<void> {
    await this.validateStartedAgainstPlan(plan, started);
    const plannedRun = this.plannedRun(plan, manifest.plannedRunId);
    const { experiment, testCase } = findPlannedRunContext(plan, plannedRun);
    const linkedStartedFields = [
      "planId",
      "planFingerprint",
      "plannedRunId",
      "attempt",
      "experimentId",
      "promptVersionId",
      "testCaseId",
      "variant",
      "repetition",
      "startedAt",
    ] as const;
    for (const field of linkedStartedFields) {
      if (manifest[field] !== started[field]) {
        throw new Error(`attempt manifest ${field} differs from its immutable started record`);
      }
    }
    if (
      canonicalJson(manifest.baseline) !== canonicalJson(started.baseline)
      || canonicalJson(manifest.artifacts.modelInput) !== canonicalJson(started.modelInput)
      || canonicalJson({
        prompt: manifest.fingerprints.prompt,
        testCase: manifest.fingerprints.testCase,
        target: manifest.fingerprints.target,
        runner: manifest.fingerprints.runner,
        plan: manifest.fingerprints.plan,
      }) !== canonicalJson(started.fingerprints)
    ) {
      throw new Error("attempt manifest baseline, model input or fingerprints differ from its immutable started record");
    }
    if (
      canonicalJson(manifest.plannedRun) !== canonicalJson(plannedRun)
      || canonicalJson(manifest.experiment) !== canonicalJson(experiment)
      || canonicalJson(manifest.testCase) !== canonicalJson(testCase)
      || canonicalJson(manifest.promptVersion) !== canonicalJson(experiment.promptVersion)
    ) {
      throw new Error("attempt manifest domain records differ from the immutable plan");
    }

    const run = parseExperimentRun(manifest.experimentRun);
    if (
      run.id !== plannedRun.id
      || run.experimentId !== plannedRun.experimentId
      || run.testCaseId !== plannedRun.testCaseId
      || run.technicalStatus !== manifest.technicalStatus
      || run.humanReviewStatus !== manifest.humanReviewStatus
      || run.startedAt !== manifest.startedAt
      || run.finishedAt !== manifest.finishedAt
      || canonicalJson(run.changedFiles) !== canonicalJson(manifest.changedFiles)
      || canonicalJson(run.evidence) !== canonicalJson(manifest.evidence)
    ) {
      throw new Error("attempt manifest ExperimentRun fields are inconsistent");
    }
    const terminalEvent = manifest.terminalEvent;
    const expectedEventType = manifest.technicalStatus === "completed" ? "run_completed" : "run_failed";
    if (
      (manifest.technicalStatus !== "completed" && manifest.technicalStatus !== "failed")
      || terminalEvent.type !== expectedEventType
      || terminalEvent.planId !== plan.id
      || terminalEvent.planFingerprint !== plan.fingerprint
      || terminalEvent.plannedRunId !== plannedRun.id
      || terminalEvent.experimentId !== plannedRun.experimentId
      || terminalEvent.testCaseId !== plannedRun.testCaseId
      || terminalEvent.variant !== plannedRun.variant
      || terminalEvent.repetition !== plannedRun.repetition
      || terminalEvent.attempt !== manifest.attempt
      || terminalEvent.timestamp !== manifest.finishedAt
      || !Number.isInteger(terminalEvent.sequence)
      || terminalEvent.sequence < 1
    ) {
      throw new Error("attempt manifest terminal event is inconsistent");
    }

    if (manifest.termination.kind === "process_exit") {
      const expectedStatus = manifest.termination.exitCode === 0 ? "completed" : "failed";
      if (
        manifest.technicalStatus !== expectedStatus
        || manifest.exitCode !== manifest.termination.exitCode
        || run.exitCode !== manifest.termination.exitCode
        || manifest.durationMs === null
        || run.durationMs !== manifest.durationMs
        || manifest.agent === null
        || manifest.workspace === null
        || manifest.artifacts.finalOutput === null
        || manifest.artifacts.stdout === null
        || manifest.artifacts.stderr === null
      ) {
        throw new Error("process-exit manifest is missing factual execution data");
      }
      const expectedConfiguration = configurationEvidenceFingerprint({
        model: manifest.agent.model,
        modelOptions: manifest.agent.modelOptions,
        experiment,
      });
      if (manifest.fingerprints.configuration !== expectedConfiguration) {
        throw new Error("process-exit manifest configuration fingerprint is inconsistent");
      }
      if (canonicalJson(manifest.workspace.changedFiles) !== canonicalJson(manifest.changedFiles)) {
        throw new Error("process-exit manifest workspace changed files are inconsistent");
      }
      if (
        (manifest.artifacts.initialGitDiffFromHead !== null) !== manifest.workspace.initialGitDiffAvailable
        || (manifest.artifacts.finalGitDiffFromHead !== null) !== manifest.workspace.finalGitDiffAvailable
      ) {
        throw new Error("process-exit manifest Git diff availability is inconsistent");
      }
      await Promise.all([
        this.readArtifact(manifest.artifacts.finalOutput),
        this.readArtifact(manifest.artifacts.stdout),
        this.readArtifact(manifest.artifacts.stderr),
        ...(manifest.artifacts.initialGitDiffFromHead
          ? [this.readArtifact(manifest.artifacts.initialGitDiffFromHead)]
          : []),
        ...(manifest.artifacts.finalGitDiffFromHead
          ? [this.readArtifact(manifest.artifacts.finalGitDiffFromHead)]
          : []),
      ]);
    } else if (manifest.termination.kind === "execution_error") {
      const errorName = manifest.termination.errorName;
      if (
        manifest.technicalStatus !== "failed"
        || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(errorName)
        || manifest.exitCode !== null
        || manifest.durationMs !== null
        || manifest.agent !== null
        || manifest.workspace !== null
        || manifest.fingerprints.configuration !== null
        || manifest.artifacts.finalOutput !== null
        || manifest.artifacts.stdout !== null
        || manifest.artifacts.stderr !== null
        || manifest.artifacts.initialGitDiffFromHead !== null
        || manifest.artifacts.finalGitDiffFromHead !== null
        || manifest.changedFiles.length !== 0
        || run.exitCode !== undefined
        || run.durationMs !== undefined
      ) {
        throw new Error("execution-error manifest fabricates unavailable execution data");
      }
      const matchingEvidence = run.evidence.some((evidence) => (
        evidence.type === "execution-error"
        && evidence.data?.name === errorName
      ));
      if (!matchingEvidence) throw new Error("execution-error manifest lacks its factual execution-error Evidence");
    } else {
      throw new Error("attempt manifest has an unknown termination kind");
    }
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
