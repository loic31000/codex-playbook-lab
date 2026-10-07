import { performance } from "node:perf_hooks";

import { createEvidence, type JsonObject } from "../domain/index.js";
import {
  type StrictEnvironmentFacts,
  type StrictExecutionEnvironment,
  type StrictRunner,
  type StrictWorkspaceSnapshot,
} from "../runner/strict/index.js";
import { canonicalJson, sha256Canonical } from "./canonical-json.js";
import {
  LocalRunExecutionError,
  type BackendRunRequest,
  type BackendRunResult,
  type ExecutionBaseline,
  type ExperimentExecutionBackend,
  type ExperimentExecutionSession,
} from "./execution-backend.js";

function policyData(facts: StrictEnvironmentFacts): JsonObject {
  return {
    image: facts.image,
    mounts: facts.mounts.map(({ type, destination, readWrite }) => ({ type, destination, readWrite })),
    environmentNames: [...facts.environmentNames],
    secretEnvironmentNames: [...facts.secretEnvironmentNames],
    networkMode: facts.networkMode,
    publishedPortCount: Object.keys(facts.publishedPorts).length,
    readOnlyRootFilesystem: facts.readOnlyRootFilesystem,
    tmpfs: { ...facts.tmpfs },
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

export function strictPolicyFingerprint(facts: StrictEnvironmentFacts): string {
  return sha256Canonical(policyData(facts));
}

function assertBaseline(actual: ExecutionBaseline, expected: ExecutionBaseline): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("strict execution baseline differs from previous orchestration state");
  }
}

function environmentBaseline(
  snapshot: StrictWorkspaceSnapshot,
  policyFingerprint: string,
): ExecutionBaseline {
  return {
    target: snapshot.target,
    workspaceFingerprint: snapshot.initialState.fingerprint,
    gitHead: snapshot.initialState.gitHead,
    gitTree: snapshot.initialState.gitTree,
    gitStatus: snapshot.initialState.gitStatus,
    image: snapshot.image,
    policyFingerprint,
  };
}

function assertEnvironmentMatches(
  environment: StrictExecutionEnvironment,
  facts: StrictEnvironmentFacts,
  baseline: ExecutionBaseline,
): void {
  if (
    environment.initialState.fingerprint !== baseline.workspaceFingerprint
    || environment.initialState.gitHead !== baseline.gitHead
    || environment.initialState.gitTree !== baseline.gitTree
    || environment.initialState.gitStatus !== baseline.gitStatus
    || environment.image !== baseline.image
    || strictPolicyFingerprint(facts) !== baseline.policyFingerprint
  ) {
    throw new Error("strict run environment differs from execution baseline");
  }
}

class StrictExperimentExecutionSession implements ExperimentExecutionSession {
  readonly baseline: ExecutionBaseline;
  readonly #snapshot: StrictWorkspaceSnapshot;

  constructor(snapshot: StrictWorkspaceSnapshot, baseline: ExecutionBaseline) {
    this.#snapshot = snapshot;
    this.baseline = baseline;
  }

  async executeRun(request: BackendRunRequest): Promise<BackendRunResult> {
    return this.#snapshot.withEnvironment(`run-${request.plannedRun.ordinal}`, async (environment) => {
      const facts = await environment.facts(request.signal);
      assertEnvironmentMatches(environment, facts, this.baseline);
      const started = performance.now();
      let execution;
      try {
        execution = await request.executor.execute({
          plannedRun: request.plannedRun,
          experiment: request.experiment,
          testCase: request.testCase,
          promptVersion: request.experiment.promptVersion,
          variant: request.plannedRun.variant,
          repetition: request.plannedRun.repetition,
          environment,
          modelInput: request.modelInput,
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new LocalRunExecutionError(error);
      }
      if (!Number.isInteger(execution.exitCode)) throw new TypeError("agent executor exitCode must be an integer");
      const workspace = await environment.captureResult(request.signal);
      const recordedAt = new Date().toISOString();
      return {
        exitCode: execution.exitCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        changedFiles: workspace.changedFiles,
        evidence: [
          createEvidence({
            type: "workspace-delta",
            recordedAt,
            source: "strict-runner",
            fingerprint: workspace.final.fingerprint,
            data: {
              initialFingerprint: workspace.initial.fingerprint,
              finalFingerprint: workspace.final.fingerprint,
              changedFiles: [...workspace.changedFiles],
              changeCount: workspace.changes.length,
            },
          }),
          ...(execution.evidence ?? []),
        ],
        facts: {
          environmentId: environment.id,
          volume: environment.volume,
          image: environment.image,
          initialWorkspaceFingerprint: environment.initialState.fingerprint,
          initialGitHead: environment.initialState.gitHead,
          initialGitTree: environment.initialState.gitTree,
          initialGitStatus: environment.initialState.gitStatus,
          policyFingerprint: strictPolicyFingerprint(facts),
          finalWorkspaceFingerprint: workspace.final.fingerprint,
        },
      };
    }, { signal: request.signal });
  }

  async close(): Promise<void> {
    await this.#snapshot.cleanup();
  }
}

export class StrictExperimentExecutionBackend implements ExperimentExecutionBackend {
  readonly #strictRunner: StrictRunner;

  constructor(strictRunner: StrictRunner) {
    this.#strictRunner = strictRunner;
  }

  async open(input: Parameters<ExperimentExecutionBackend["open"]>[0]): Promise<ExperimentExecutionSession> {
    const snapshot = await this.#strictRunner.prepare({
      target: input.target,
      targetPath: input.targetPath,
      signal: input.signal,
    });
    try {
      const policyFingerprint = await snapshot.withEnvironment("policy-probe", async (environment) => (
        strictPolicyFingerprint(await environment.facts(input.signal))
      ), { signal: input.signal });
      const baseline = environmentBaseline(snapshot, policyFingerprint);
      if (input.expectedBaseline) assertBaseline(baseline, input.expectedBaseline);
      return new StrictExperimentExecutionSession(snapshot, baseline);
    } catch (error) {
      await snapshot.cleanup();
      throw error;
    }
  }
}
