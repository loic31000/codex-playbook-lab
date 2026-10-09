import type { ExperimentExecutionPlan } from "../experiment/index.js";
import type {
  ExperimentAgentExecutor,
  ExperimentExecutionBackend,
} from "../experiment/index.js";
import type { ExploratoryCaseGenerator } from "../explore/index.js";
import type { FilesystemEvidenceStore } from "../evidence/index.js";
import type { ApplicationEventSink } from "./events.js";
import type { DiagnosticsPort } from "./diagnostics.js";

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
  readonly now?: () => Date;
  readonly createOperationId?: () => string;
  readonly onEvent?: ApplicationEventSink;
}
