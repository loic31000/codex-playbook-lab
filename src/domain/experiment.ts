export const TECHNICAL_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TechnicalStatus = (typeof TECHNICAL_STATUSES)[number];

export const HUMAN_REVIEW_STATUSES = [
  "pending_review",
  "approved",
  "rejected",
  "uncertain",
] as const;

export type HumanReviewStatus = (typeof HUMAN_REVIEW_STATUSES)[number];

export const HUMAN_DECISION_STATUSES = ["approved", "rejected", "uncertain"] as const;

export type HumanDecisionStatus = Exclude<HumanReviewStatus, "pending_review">;

export const HUMAN_REVIEW_LABELS: Readonly<Record<HumanReviewStatus, string>> = {
  pending_review: "À vérifier",
  approved: "Validé",
  rejected: "Refusé",
  uncertain: "Incertain",
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface TargetRef {
  readonly id: string;
  readonly source: string;
  readonly revision?: string;
}

export interface PromptDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface PromptVersion {
  readonly id: string;
  readonly promptDefinitionId: string;
  readonly content: string;
  readonly fingerprint?: string;
}

interface TestCaseBase {
  readonly id: string;
  readonly title: string;
  readonly input: string;
}

export interface FixedCase extends TestCaseBase {
  readonly kind: "fixed";
}

export type GenerationInstruction =
  | { readonly kind: "content"; readonly value: string }
  | { readonly kind: "fingerprint"; readonly value: string }
  | { readonly kind: "reference"; readonly value: string };

export interface GenerationProvenance {
  readonly generatorId: string;
  readonly generatorVersion?: string;
  readonly generatedAt: string;
  readonly seed?: string | number;
  readonly instruction: GenerationInstruction;
  readonly parentRef?: string;
}

export interface GeneratedCase extends TestCaseBase {
  readonly kind: "generated";
  readonly provenance: GenerationProvenance;
}

export type TestCase = FixedCase | GeneratedCase;

export interface EvidenceMetric {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
}

export interface Evidence {
  readonly type: string;
  readonly recordedAt: string;
  readonly source: string;
  readonly fingerprint?: string;
  readonly artifactRef?: string;
  readonly metric?: EvidenceMetric;
  readonly data?: JsonObject;
}

export interface ExperimentRun {
  readonly id: string;
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly technicalStatus: TechnicalStatus;
  readonly humanReviewStatus: HumanReviewStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly reviewer?: string;
  readonly reviewedAt?: string;
  readonly reviewComment?: string;
}

export interface ExperimentConfiguration {
  readonly repetitions: number;
  readonly timeoutMs?: number;
}

export interface Experiment {
  readonly id: string;
  readonly promptDefinition: PromptDefinition;
  readonly promptVersion: PromptVersion;
  readonly target: TargetRef;
  readonly testCases: readonly TestCase[];
  readonly configuration: ExperimentConfiguration;
  readonly runs: readonly ExperimentRun[];
}

export interface NewExperimentRunInput {
  readonly id: string;
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly technicalStatus?: TechnicalStatus;
  readonly startedAt?: string;
  readonly changedFiles?: readonly string[];
  readonly evidence?: readonly Evidence[];
}

export interface TechnicalRunUpdate {
  readonly technicalStatus: TechnicalStatus;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly changedFiles?: readonly string[];
  readonly evidence?: readonly Evidence[];
}

export interface HumanReviewInput {
  readonly status: HumanDecisionStatus;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly comment?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function assertOnlyKeys(record: UnknownRecord, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${path}.${key} is not supported`);
    }
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, path);
}

function isoTimestamp(value: unknown, path: string): string {
  const timestamp = nonEmptyString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${path} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

function optionalIsoTimestamp(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : isoTimestamp(value, path);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${path} must be a positive integer`);
  }
  return value as number;
}

function optionalInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new TypeError(`${path} must be an integer`);
  return value as number;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
}

function optionalField<T extends UnknownRecord>(output: T, key: string, value: unknown): T {
  if (value !== undefined) (output as UnknownRecord)[key] = value;
  return output;
}

function copyJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => copyJsonValue(entry, `${path}[${index}]`));
  const record = asRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, copyJsonValue(entry, `${path}.${key}`)]),
  );
}

const FORBIDDEN_EVIDENCE_LABELS = new Set([
  "approved",
  "valide",
  "validated",
  "rejected",
  "refuse",
  "uncertain",
  "incertain",
  "pendingreview",
  "averifier",
  "winner",
  "promptwinner",
  "bestprompt",
  "betterprompt",
  "worseprompt",
  "iscorrect",
  "correct",
  "incorrect",
  "verdict",
  "decision",
  "humanreviewstatus",
  "reviewstatus",
]);

const FORBIDDEN_EVIDENCE_VALUES = new Set([
  "approved",
  "valide",
  "validated",
  "rejected",
  "refuse",
  "uncertain",
  "incertain",
  "pendingreview",
  "averifier",
]);

function normalizeEvidenceLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function assertFactualEvidenceLabel(value: unknown, path: string): string {
  const label = nonEmptyString(value, path);
  if (FORBIDDEN_EVIDENCE_LABELS.has(normalizeEvidenceLabel(label))) {
    throw new TypeError(`${path} is a verdict, not evidence`);
  }
  return label;
}

function assertNoVerdictFields(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoVerdictFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string") {
    if (FORBIDDEN_EVIDENCE_VALUES.has(normalizeEvidenceLabel(value))) {
      throw new TypeError(`${path} contains a human review status, not evidence`);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    assertFactualEvidenceLabel(key, `${path}.${key}`);
    assertNoVerdictFields(entry, `${path}.${key}`);
  }
}

export function parseTechnicalStatus(value: unknown): TechnicalStatus {
  if (typeof value !== "string" || !TECHNICAL_STATUSES.includes(value as TechnicalStatus)) {
    throw new TypeError(`unknown TechnicalStatus: ${String(value)}`);
  }
  return value as TechnicalStatus;
}

export function parseHumanReviewStatus(value: unknown): HumanReviewStatus {
  if (typeof value !== "string" || !HUMAN_REVIEW_STATUSES.includes(value as HumanReviewStatus)) {
    throw new TypeError(`unknown HumanReviewStatus: ${String(value)}`);
  }
  return value as HumanReviewStatus;
}

export function parseHumanDecisionStatus(value: unknown): HumanDecisionStatus {
  if (typeof value !== "string" || !HUMAN_DECISION_STATUSES.includes(value as HumanDecisionStatus)) {
    throw new TypeError(`unknown HumanDecisionStatus: ${String(value)}`);
  }
  return value as HumanDecisionStatus;
}

export function createTargetRef(value: unknown): TargetRef {
  const input = asRecord(value, "target");
  assertOnlyKeys(input, ["id", "source", "revision"], "target");
  return optionalField(
    { id: nonEmptyString(input.id, "target.id"), source: nonEmptyString(input.source, "target.source") },
    "revision",
    optionalString(input.revision, "target.revision"),
  );
}

export function createPromptDefinition(value: unknown): PromptDefinition {
  const input = asRecord(value, "promptDefinition");
  assertOnlyKeys(input, ["id", "name", "description"], "promptDefinition");
  return optionalField(
    { id: nonEmptyString(input.id, "promptDefinition.id"), name: nonEmptyString(input.name, "promptDefinition.name") },
    "description",
    optionalString(input.description, "promptDefinition.description"),
  );
}

export function createPromptVersion(value: unknown): PromptVersion {
  const input = asRecord(value, "promptVersion");
  assertOnlyKeys(input, ["id", "promptDefinitionId", "content", "fingerprint"], "promptVersion");
  return optionalField(
    {
      id: nonEmptyString(input.id, "promptVersion.id"),
      promptDefinitionId: nonEmptyString(input.promptDefinitionId, "promptVersion.promptDefinitionId"),
      content: nonEmptyString(input.content, "promptVersion.content"),
    },
    "fingerprint",
    optionalString(input.fingerprint, "promptVersion.fingerprint"),
  );
}

function createGenerationInstruction(value: unknown): GenerationInstruction {
  const input = asRecord(value, "provenance.instruction");
  assertOnlyKeys(input, ["kind", "value"], "provenance.instruction");
  if (input.kind !== "content" && input.kind !== "fingerprint" && input.kind !== "reference") {
    throw new TypeError("provenance.instruction.kind must be content, fingerprint or reference");
  }
  return { kind: input.kind, value: nonEmptyString(input.value, "provenance.instruction.value") };
}

export function createGenerationProvenance(value: unknown): GenerationProvenance {
  const input = asRecord(value, "provenance");
  assertOnlyKeys(
    input,
    ["generatorId", "generatorVersion", "generatedAt", "seed", "instruction", "parentRef"],
    "provenance",
  );
  if (input.seed !== undefined && typeof input.seed !== "string" && typeof input.seed !== "number") {
    throw new TypeError("provenance.seed must be a string or number");
  }
  if (typeof input.seed === "number" && !Number.isFinite(input.seed)) {
    throw new TypeError("provenance.seed must be finite");
  }
  const output: UnknownRecord = {
    generatorId: nonEmptyString(input.generatorId, "provenance.generatorId"),
    generatedAt: isoTimestamp(input.generatedAt, "provenance.generatedAt"),
    instruction: createGenerationInstruction(input.instruction),
  };
  optionalField(output, "generatorVersion", optionalString(input.generatorVersion, "provenance.generatorVersion"));
  optionalField(output, "seed", input.seed as string | number | undefined);
  optionalField(output, "parentRef", optionalString(input.parentRef, "provenance.parentRef"));
  return output as unknown as GenerationProvenance;
}

export function createTestCase(value: unknown): TestCase {
  const input = asRecord(value, "testCase");
  if (input.kind === "fixed") {
    assertOnlyKeys(input, ["kind", "id", "title", "input"], "fixedCase");
    return {
      kind: "fixed",
      id: nonEmptyString(input.id, "fixedCase.id"),
      title: nonEmptyString(input.title, "fixedCase.title"),
      input: nonEmptyString(input.input, "fixedCase.input"),
    };
  }
  if (input.kind === "generated") {
    assertOnlyKeys(input, ["kind", "id", "title", "input", "provenance"], "generatedCase");
    return {
      kind: "generated",
      id: nonEmptyString(input.id, "generatedCase.id"),
      title: nonEmptyString(input.title, "generatedCase.title"),
      input: nonEmptyString(input.input, "generatedCase.input"),
      provenance: createGenerationProvenance(input.provenance),
    };
  }
  throw new TypeError("testCase.kind must be fixed or generated");
}

export function createEvidence(value: unknown): Evidence {
  const input = asRecord(value, "evidence");
  assertOnlyKeys(
    input,
    ["type", "recordedAt", "source", "fingerprint", "artifactRef", "metric", "data"],
    "evidence",
  );
  const output: UnknownRecord = {
    type: assertFactualEvidenceLabel(input.type, "evidence.type"),
    recordedAt: isoTimestamp(input.recordedAt, "evidence.recordedAt"),
    source: nonEmptyString(input.source, "evidence.source"),
  };
  optionalField(output, "fingerprint", optionalString(input.fingerprint, "evidence.fingerprint"));
  optionalField(output, "artifactRef", optionalString(input.artifactRef, "evidence.artifactRef"));
  if (input.metric !== undefined) {
    const metric = asRecord(input.metric, "evidence.metric");
    assertOnlyKeys(metric, ["name", "value", "unit"], "evidence.metric");
    if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
      throw new TypeError("evidence.metric.value must be a finite number");
    }
    output.metric = optionalField(
      { name: assertFactualEvidenceLabel(metric.name, "evidence.metric.name"), value: metric.value },
      "unit",
      optionalString(metric.unit, "evidence.metric.unit"),
    );
  }
  if (input.data !== undefined) {
    const data = copyJsonValue(input.data, "evidence.data");
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new TypeError("evidence.data must be a JSON object");
    }
    assertNoVerdictFields(data, "evidence.data");
    output.data = data;
  }
  return output as unknown as Evidence;
}

function parseExperimentRun(value: unknown): ExperimentRun {
  const input = asRecord(value, "run");
  assertOnlyKeys(
    input,
    [
      "id", "experimentId", "testCaseId", "technicalStatus", "humanReviewStatus", "startedAt", "finishedAt",
      "exitCode", "durationMs", "changedFiles", "evidence", "reviewer", "reviewedAt", "reviewComment",
    ],
    "run",
  );
  if (!Array.isArray(input.evidence)) throw new TypeError("run.evidence must be an array");
  const output: UnknownRecord = {
    id: nonEmptyString(input.id, "run.id"),
    experimentId: nonEmptyString(input.experimentId, "run.experimentId"),
    testCaseId: nonEmptyString(input.testCaseId, "run.testCaseId"),
    technicalStatus: parseTechnicalStatus(input.technicalStatus),
    humanReviewStatus: parseHumanReviewStatus(input.humanReviewStatus),
    changedFiles: stringArray(input.changedFiles, "run.changedFiles"),
    evidence: input.evidence.map(createEvidence),
  };
  optionalField(output, "startedAt", optionalIsoTimestamp(input.startedAt, "run.startedAt"));
  optionalField(output, "finishedAt", optionalIsoTimestamp(input.finishedAt, "run.finishedAt"));
  optionalField(output, "exitCode", optionalInteger(input.exitCode, "run.exitCode"));
  optionalField(
    output,
    "durationMs",
    input.durationMs === undefined ? undefined : nonNegativeInteger(input.durationMs, "run.durationMs"),
  );
  optionalField(output, "reviewer", optionalString(input.reviewer, "run.reviewer"));
  optionalField(output, "reviewedAt", optionalIsoTimestamp(input.reviewedAt, "run.reviewedAt"));
  optionalField(output, "reviewComment", optionalString(input.reviewComment, "run.reviewComment"));

  const hasReviewDetails = output.reviewer !== undefined || output.reviewedAt !== undefined || output.reviewComment !== undefined;
  if (output.humanReviewStatus === "pending_review" && hasReviewDetails) {
    throw new TypeError("a pending human review cannot contain review details");
  }
  if (output.humanReviewStatus !== "pending_review" && (output.reviewer === undefined || output.reviewedAt === undefined)) {
    throw new TypeError("a human decision requires reviewer and reviewedAt");
  }
  return output as unknown as ExperimentRun;
}

export function createExperimentRun(input: NewExperimentRunInput): ExperimentRun {
  return parseExperimentRun({
    id: input.id,
    experimentId: input.experimentId,
    testCaseId: input.testCaseId,
    technicalStatus: input.technicalStatus ?? "pending",
    humanReviewStatus: "pending_review",
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    changedFiles: input.changedFiles ?? [],
    evidence: input.evidence ?? [],
  });
}

export function updateRunTechnicalState(run: ExperimentRun, update: TechnicalRunUpdate): ExperimentRun {
  return parseExperimentRun({
    ...run,
    technicalStatus: update.technicalStatus,
    ...(update.finishedAt === undefined ? {} : { finishedAt: update.finishedAt }),
    ...(update.exitCode === undefined ? {} : { exitCode: update.exitCode }),
    ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs }),
    ...(update.changedFiles === undefined ? {} : { changedFiles: update.changedFiles }),
    evidence: [...run.evidence, ...(update.evidence ?? [])],
  });
}

export function recordHumanReview(run: ExperimentRun, review: HumanReviewInput): ExperimentRun {
  return parseExperimentRun({
    ...run,
    humanReviewStatus: parseHumanDecisionStatus(review.status),
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    ...(review.comment === undefined ? {} : { reviewComment: review.comment }),
  });
}

function createExperimentConfiguration(value: unknown): ExperimentConfiguration {
  const input = asRecord(value, "configuration");
  assertOnlyKeys(input, ["repetitions", "timeoutMs"], "configuration");
  return optionalField(
    { repetitions: positiveInteger(input.repetitions, "configuration.repetitions") },
    "timeoutMs",
    input.timeoutMs === undefined ? undefined : positiveInteger(input.timeoutMs, "configuration.timeoutMs"),
  );
}

function assertUniqueIds(values: readonly { readonly id: string }[], path: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new TypeError(`${path} contains duplicate id ${value.id}`);
    ids.add(value.id);
  }
}

export function createExperiment(value: unknown): Experiment {
  const input = asRecord(value, "experiment");
  assertOnlyKeys(
    input,
    ["id", "promptDefinition", "promptVersion", "target", "testCases", "configuration", "runs"],
    "experiment",
  );
  const id = nonEmptyString(input.id, "experiment.id");
  const promptDefinition = createPromptDefinition(input.promptDefinition);
  const promptVersion = createPromptVersion(input.promptVersion);
  const target = createTargetRef(input.target);
  if (!Array.isArray(input.testCases) || input.testCases.length === 0) {
    throw new TypeError("experiment.testCases must contain at least one case");
  }
  if (!Array.isArray(input.runs)) throw new TypeError("experiment.runs must be an array");
  const testCases = input.testCases.map(createTestCase);
  const runs = input.runs.map(parseExperimentRun);
  assertUniqueIds(testCases, "experiment.testCases");
  assertUniqueIds(runs, "experiment.runs");
  if (promptVersion.promptDefinitionId !== promptDefinition.id) {
    throw new TypeError("promptVersion.promptDefinitionId must reference promptDefinition.id");
  }
  const testCaseIds = new Set(testCases.map((testCase) => testCase.id));
  for (const run of runs) {
    if (run.experimentId !== id) throw new TypeError(`run ${run.id} references another experiment`);
    if (!testCaseIds.has(run.testCaseId)) throw new TypeError(`run ${run.id} references an unknown test case`);
  }
  return {
    id,
    promptDefinition,
    promptVersion,
    target,
    testCases,
    configuration: createExperimentConfiguration(input.configuration),
    runs,
  };
}

export function serializeExperiment(experiment: Experiment): string {
  return `${JSON.stringify(createExperiment(experiment), null, 2)}\n`;
}

export function parseExperimentJson(json: string): Experiment {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new TypeError(`invalid Experiment JSON: ${(error as Error).message}`);
  }
  return createExperiment(value);
}
