import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  createEvidence,
  createExperiment,
  createExperimentRun,
  updateRunTechnicalState,
  type Evidence,
  type Experiment,
  type ExperimentRun,
  type FixedCase,
  type JsonObject,
  type PromptVersion,
  type TargetRef,
} from "../domain/index.js";
import {
  type StrictEnvironmentFacts,
  type StrictExecutionEnvironment,
  type StrictRunner,
  type StrictWorkspaceResult,
} from "../runner/strict/index.js";
import type { FixedBenchmarkDefinition } from "./benchmark-discovery.js";
import { buildFixedBenchmarkModelInput, type FixedBenchmarkVariant } from "./model-input.js";

export interface FixedBenchmarkAgentRequest {
  readonly variant: FixedBenchmarkVariant;
  readonly environment: StrictExecutionEnvironment;
  readonly modelInput: string;
  readonly experiment: Experiment;
  readonly testCase: FixedCase;
  readonly promptVersion: PromptVersion;
  readonly signal?: AbortSignal;
}

export interface FixedBenchmarkAgentExecution {
  readonly exitCode: number;
  readonly evidence?: readonly Evidence[];
}

export interface FixedBenchmarkAgentExecutor {
  execute(request: FixedBenchmarkAgentRequest): Promise<FixedBenchmarkAgentExecution>;
}

export interface FixedBenchmarkEnvironmentResult {
  readonly id: string;
  readonly volume: string;
  readonly image: string;
  readonly initialFingerprint: string;
  readonly policyFacts: StrictEnvironmentFacts;
}

export interface FixedBenchmarkVariantResult {
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly promptVersionId: string;
  readonly target: TargetRef;
  readonly variant: FixedBenchmarkVariant;
  readonly modelInputFingerprint: string;
  readonly environment: FixedBenchmarkEnvironmentResult;
  readonly workspace: StrictWorkspaceResult;
  readonly run: ExperimentRun;
}

export interface FixedBenchmarkExecutionResult {
  readonly experimentId: string;
  readonly testCaseId: string;
  readonly promptVersionId: string;
  readonly target: TargetRef;
  readonly baseline: FixedBenchmarkVariantResult;
  readonly treatment: FixedBenchmarkVariantResult;
}

export interface RunFixedBenchmarkInput {
  readonly strictRunner: StrictRunner;
  readonly targetPath: string;
  readonly experiment: Experiment;
  readonly benchmark: FixedBenchmarkDefinition;
  readonly executor: FixedBenchmarkAgentExecutor;
  readonly signal?: AbortSignal;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function policyData(facts: StrictEnvironmentFacts): JsonObject {
  return {
    image: facts.image,
    mounts: facts.mounts.map((mount) => ({
      type: mount.type,
      destination: mount.destination,
      readWrite: mount.readWrite,
    })),
    environmentNames: [...facts.environmentNames],
    secretEnvironmentNames: [...facts.secretEnvironmentNames],
    networkMode: facts.networkMode,
    publishedPortCount: Object.keys(facts.publishedPorts).length,
    readOnlyRootFilesystem: facts.readOnlyRootFilesystem,
    tmpfsPaths: Object.keys(facts.tmpfs).sort(),
    initProcessEnabled: facts.initProcessEnabled,
    capDrop: [...facts.capDrop],
    securityOptions: [...facts.securityOptions],
    user: facts.user,
    pidsLimit: facts.pidsLimit,
    memoryBytes: facts.memoryBytes,
    nanoCpus: facts.nanoCpus,
    controlTransport: facts.controlTransport,
  };
}

function comparablePolicy(facts: StrictEnvironmentFacts): string {
  return JSON.stringify(policyData(facts));
}

function assertBenchmarkReferences(experiment: Experiment, benchmark: FixedBenchmarkDefinition): FixedCase {
  if (benchmark.promptDefinitionId !== experiment.promptDefinition.id) {
    throw new Error("benchmark references another PromptDefinition");
  }
  if (experiment.promptVersion.promptDefinitionId !== benchmark.promptDefinitionId) {
    throw new Error("PromptVersion references another PromptDefinition");
  }
  const testCase = experiment.testCases.find(({ id }) => id === benchmark.testCase.id);
  if (!testCase || testCase.kind !== "fixed") throw new Error("benchmark FixedCase is absent from Experiment");
  if (testCase.title !== benchmark.testCase.title || testCase.input !== benchmark.testCase.input) {
    throw new Error("Experiment FixedCase differs from benchmark definition");
  }
  return testCase;
}

async function executeVariant(input: {
  readonly variant: FixedBenchmarkVariant;
  readonly environment: StrictExecutionEnvironment;
  readonly experiment: Experiment;
  readonly testCase: FixedCase;
  readonly executor: FixedBenchmarkAgentExecutor;
  readonly signal?: AbortSignal;
}): Promise<FixedBenchmarkVariantResult> {
  const modelInput = buildFixedBenchmarkModelInput({
    variant: input.variant,
    promptVersion: input.experiment.promptVersion,
    testCase: input.testCase,
  });
  const modelInputFingerprint = sha256(modelInput);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const policyFacts = await input.environment.facts(input.signal);
  const execution = await input.executor.execute({
    variant: input.variant,
    environment: input.environment,
    modelInput,
    experiment: input.experiment,
    testCase: input.testCase,
    promptVersion: input.experiment.promptVersion,
    signal: input.signal,
  });
  if (!Number.isInteger(execution.exitCode)) throw new TypeError("agent executor exitCode must be an integer");
  const workspace = await input.environment.captureResult(input.signal);
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const evidence: Evidence[] = [
    createEvidence({
      type: "model-input-fingerprint",
      recordedAt: finishedAt,
      source: "fixed-benchmark-runner",
      fingerprint: modelInputFingerprint,
      data: { variant: input.variant, characterCount: modelInput.length },
    }),
    createEvidence({
      type: "strict-environment-facts",
      recordedAt: finishedAt,
      source: "strict-runner",
      fingerprint: input.environment.initialState.fingerprint,
      data: policyData(policyFacts),
    }),
    createEvidence({
      type: "workspace-delta",
      recordedAt: finishedAt,
      source: "strict-runner",
      fingerprint: workspace.final.fingerprint,
      data: {
        initialFingerprint: workspace.initial.fingerprint,
        finalFingerprint: workspace.final.fingerprint,
        changedFiles: [...workspace.changedFiles],
        changeCount: workspace.changes.length,
      },
    }),
    ...(execution.evidence ?? []).map((entry) => createEvidence(entry)),
  ];
  const pending = createExperimentRun({
    id: `${input.experiment.id}:${input.testCase.id}:${input.variant}`,
    experimentId: input.experiment.id,
    testCaseId: input.testCase.id,
    technicalStatus: "running",
    startedAt,
  });
  const run = updateRunTechnicalState(pending, {
    technicalStatus: execution.exitCode === 0 ? "completed" : "failed",
    finishedAt,
    exitCode: execution.exitCode,
    durationMs,
    changedFiles: workspace.changedFiles,
    evidence,
  });
  return {
    experimentId: input.experiment.id,
    testCaseId: input.testCase.id,
    promptVersionId: input.experiment.promptVersion.id,
    target: input.experiment.target,
    variant: input.variant,
    modelInputFingerprint,
    environment: {
      id: input.environment.id,
      volume: input.environment.volume,
      image: input.environment.image,
      initialFingerprint: input.environment.initialState.fingerprint,
      policyFacts,
    },
    workspace,
    run,
  };
}

function assertEquivalentInitialConditions(
  baseline: FixedBenchmarkVariantResult,
  treatment: FixedBenchmarkVariantResult,
): void {
  const baselineInitial = baseline.workspace.initial;
  const treatmentInitial = treatment.workspace.initial;
  if (
    baseline.environment.volume === treatment.environment.volume
    || baseline.environment.image !== treatment.environment.image
    || baselineInitial.fingerprint !== treatmentInitial.fingerprint
    || baselineInitial.gitHead !== treatmentInitial.gitHead
    || baselineInitial.gitTree !== treatmentInitial.gitTree
    || baselineInitial.gitStatus !== treatmentInitial.gitStatus
    || comparablePolicy(baseline.environment.policyFacts) !== comparablePolicy(treatment.environment.policyFacts)
  ) {
    throw new Error("baseline and treatment do not share equivalent strict initial conditions");
  }
}

export async function runFixedBenchmark(input: RunFixedBenchmarkInput): Promise<FixedBenchmarkExecutionResult> {
  const experiment = createExperiment(input.experiment);
  const testCase = assertBenchmarkReferences(experiment, input.benchmark);
  return input.strictRunner.withSnapshot({
    target: experiment.target,
    targetPath: input.targetPath,
    signal: input.signal,
  }, async (snapshot) => {
    const baseline = await snapshot.withEnvironment("baseline", (environment) => executeVariant({
      variant: "baseline",
      environment,
      experiment,
      testCase,
      executor: input.executor,
      signal: input.signal,
    }), { signal: input.signal });
    const treatment = await snapshot.withEnvironment("treatment", (environment) => executeVariant({
      variant: "treatment",
      environment,
      experiment,
      testCase,
      executor: input.executor,
      signal: input.signal,
    }), { signal: input.signal });
    assertEquivalentInitialConditions(baseline, treatment);
    return {
      experimentId: experiment.id,
      testCaseId: testCase.id,
      promptVersionId: experiment.promptVersion.id,
      target: experiment.target,
      baseline,
      treatment,
    };
  });
}
