import {
  ApplicationError,
  applicationError,
  isInfrastructureError,
  nodeErrorCode,
  type LabApplication,
} from "../application/index.js";
import type { CliDefaults, CliDependencies } from "./index.js";
import { option, parseCliArguments } from "./parser.js";
import { CLI_EXIT_CODES, renderApplicationError, writeLine, type CliWriter } from "./render.js";

export interface CliRuntime {
  readonly applicationMain: (argv: readonly string[], dependencies: CliDependencies) => Promise<number>;
  readonly createApplication: () => LabApplication;
}

export interface CliBootstrapDependencies {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  readonly loadRuntime: () => Promise<CliRuntime>;
  readonly loadDefaults: (configPath?: string) => Promise<CliDefaults>;
  readonly signals?: CliDependencies["signals"];
  readonly legacyMain?: CliDependencies["legacyMain"];
}

function mapBootstrapError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof SyntaxError || nodeErrorCode(error) === "ERR_CONFIG_INVALID") {
    return applicationError(error, "INVALID_ARGUMENT", "CLI configuration is invalid");
  }
  if (isInfrastructureError(error)) {
    return applicationError(error, "INFRASTRUCTURE_FAILURE", "CLI configuration or runtime is unavailable");
  }
  return applicationError(error, "INTERNAL_ERROR", "CLI bootstrap failed");
}

export async function runCliBootstrap(
  argv: readonly string[],
  dependencies: CliBootstrapDependencies,
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const parsed = parseCliArguments(argv);
    const [runtime, defaults] = await Promise.all([
      dependencies.loadRuntime(),
      dependencies.loadDefaults(option(parsed, "config")),
    ]);
    return await runtime.applicationMain(argv, {
      application: runtime.createApplication(),
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
      defaults,
      ...(dependencies.signals === undefined ? {} : { signals: dependencies.signals }),
      ...(dependencies.legacyMain === undefined ? {} : { legacyMain: dependencies.legacyMain }),
    });
  } catch (error) {
    const mapped = mapBootstrapError(error);
    writeLine(dependencies.stderr, renderApplicationError(mapped, json));
    return CLI_EXIT_CODES[mapped.code];
  }
}
