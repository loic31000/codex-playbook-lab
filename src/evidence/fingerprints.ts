import type { Experiment, JsonObject, PromptVersion, TargetRef, TestCase } from "../domain/index.js";
import { sha256Canonical, sha256Exact } from "../experiment/canonical-json.js";
import type { ExecutionBaseline } from "../experiment/execution-backend.js";

export function promptEvidenceFingerprint(promptVersion: PromptVersion): string {
  return sha256Exact(promptVersion.content);
}

export function caseEvidenceFingerprint(testCase: TestCase): string {
  const fingerprint = sha256Exact(testCase.input);
  if (testCase.kind === "generated" && fingerprint !== testCase.provenance.contentFingerprint) {
    throw new Error(`GeneratedCase ${testCase.id} content fingerprint differs from its exact input`);
  }
  return fingerprint;
}

export function targetEvidenceFingerprint(target: TargetRef, baseline: ExecutionBaseline): string {
  return sha256Canonical({
    target,
    workspaceFingerprint: baseline.workspaceFingerprint,
    gitHead: baseline.gitHead,
    gitTree: baseline.gitTree,
    gitStatus: baseline.gitStatus,
  });
}

export function runnerEvidenceFingerprint(baseline: ExecutionBaseline): string {
  return sha256Canonical({
    image: baseline.image,
    policyFingerprint: baseline.policyFingerprint,
    inputContract: "experiment-model-input/v1",
    executionContract: "strict-experiment-execution/v1",
  });
}

export function configurationEvidenceFingerprint(input: {
  readonly model: string;
  readonly modelOptions: JsonObject;
  readonly experiment: Experiment;
}): string {
  return sha256Canonical({
    model: input.model,
    modelOptions: input.modelOptions,
    timeoutMs: input.experiment.configuration.timeoutMs ?? null,
  });
}
