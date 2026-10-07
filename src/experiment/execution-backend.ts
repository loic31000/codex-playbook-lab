import type {
  Evidence,
  Experiment,
  PromptVersion,
  TargetRef,
  TestCase,
} from "../domain/index.js";
import type { ProcessResult, RunProcessOptions } from "../runner/strict/index.js";
import type { PlannedRun } from "./plan.js";

export class LocalRunExecutionError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "local run execution failed");
    this.name = "LocalRunExecutionError";
    this.cause = cause;
  }
}

export interface ExecutionBaseline {
  readonly target: TargetRef;
  readonly workspaceFingerprint: string;
  readonly gitHead: string | null;
  readonly gitTree: string | null;
  readonly gitStatus: string | null;
  readonly image: string;
  readonly policyFingerprint: string;
}

export interface ExperimentAgentEnvironment {
  readonly id: string;
  readonly volume: string;
  readonly image: string;
  exec(command: readonly string[], options?: RunProcessOptions): Promise<ProcessResult>;
}

export interface ExperimentAgentExecutor {
  execute(request: {
    readonly plannedRun: PlannedRun;
    readonly experiment: Experiment;
    readonly testCase: TestCase;
    readonly promptVersion: PromptVersion;
    readonly variant: PlannedRun["variant"];
    readonly repetition: number;
    readonly environment: ExperimentAgentEnvironment;
    readonly modelInput: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly exitCode: number;
    readonly evidence?: readonly Evidence[];
  }>;
}

export interface ExecutionAttemptFacts {
  readonly environmentId: string;
  readonly volume: string;
  readonly image: string;
  readonly initialWorkspaceFingerprint: string;
  readonly initialGitHead: string | null;
  readonly initialGitTree: string | null;
  readonly initialGitStatus: string | null;
  readonly policyFingerprint: string;
  readonly finalWorkspaceFingerprint?: string;
}

export interface BackendRunResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly facts: ExecutionAttemptFacts;
}

export interface BackendRunRequest {
  readonly plannedRun: PlannedRun;
  readonly experiment: Experiment;
  readonly testCase: TestCase;
  readonly modelInput: string;
  readonly executor: ExperimentAgentExecutor;
  readonly signal?: AbortSignal;
}

export interface ExperimentExecutionSession {
  readonly baseline: ExecutionBaseline;
  executeRun(request: BackendRunRequest): Promise<BackendRunResult>;
  close(): Promise<void>;
}

export interface ExperimentExecutionBackend {
  open(input: {
    readonly target: TargetRef;
    readonly targetPath: string;
    readonly expectedBaseline?: ExecutionBaseline;
    readonly signal?: AbortSignal;
  }): Promise<ExperimentExecutionSession>;
}
