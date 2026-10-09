import type { ExperimentExecutionPlan } from "../experiment/index.js";
import type {
  ExperimentAgentExecutor,
  ExperimentExecutionBackend,
} from "../experiment/index.js";
import type { ExploratoryCaseGenerator } from "../explore/index.js";
import type { FilesystemEvidenceStore } from "../evidence/index.js";
import type { ApplicationEventSink } from "./events.js";
import type { DiagnosticsPort } from "./diagnostics.js";
import type { DiscoveredPrompt, FixedBenchmarkDefinition } from "../fixed/index.js";

export type PromptDiscoveryPort = (root: string) => Promise<readonly DiscoveredPrompt[]>;
export type BenchmarkDiscoveryPort = (
  root: string,
  prompts: readonly DiscoveredPrompt[],
) => Promise<readonly FixedBenchmarkDefinition[]>;

export interface ExecutionBackendFactoryInput {
  readonly plan: ExperimentExecutionPlan;
  readonly targetPath: string;
}

export type ExecutionBackendFactory = (
  input: ExecutionBackendFactoryInput,
) => ExperimentExecutionBackend | Promise<ExperimentExecutionBackend>;

export interface ApplicationDependencies {
  readonly openEvidenceStore: (root: string) => Promise<FilesystemEvidenceStore>;
  readonly executionBackendFactory?: ExecutionBackendFactory;
  readonly agentExecutor?: ExperimentAgentExecutor;
  readonly exploratoryGenerator?: ExploratoryCaseGenerator;
  readonly diagnostics?: DiagnosticsPort;
  readonly promptDiscovery?: PromptDiscoveryPort;
  readonly benchmarkDiscovery?: BenchmarkDiscoveryPort;
  readonly now?: () => Date;
  readonly createOperationId?: () => string;
  readonly onEvent?: ApplicationEventSink;
}
