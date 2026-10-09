import {
  ApplicationError,
  applicationError,
  type LabApplication,
} from "../application/index.js";
import { parseCliArguments, option, requiredOption, type ParsedCliArguments } from "./parser.js";
import {
  CLI_EXIT_CODES,
  renderApplicationError,
  renderDiagnostics,
  writeJson,
  writeLine,
  type CliWriter,
} from "./render.js";

export interface CliDefaults {
  readonly repoDir?: string;
  readonly playbookDir?: string;
  readonly benchmarksDir?: string;
  readonly evidenceStoreDir?: string;
}

export interface CliSignals {
  onSigint(handler: () => void): () => void;
}

export interface CliDependencies {
  readonly application: LabApplication;
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  readonly defaults?: CliDefaults;
  readonly signals?: CliSignals;
  readonly legacyMain?: (argv: readonly string[]) => Promise<number>;
}

const LEGACY_TOP_LEVEL = new Set(["suite", "test", "benchmark", "resume", "results", "clean", "run-test", "save-run"]);

function isJson(parsed: ParsedCliArguments): boolean {
  return parsed.options.json === true;
}

function output(dependencies: CliDependencies, parsed: ParsedCliArguments, value: unknown, human?: string): void {
  if (isJson(parsed)) writeJson(dependencies.stdout, value);
  else writeLine(dependencies.stdout, human ?? JSON.stringify(value));
}

function parseSpec(parsed: ParsedCliArguments): Record<string, unknown> {
  const raw = requiredOption(parsed, "spec");
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("spec must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new ApplicationError("INVALID_ARGUMENT", "--spec must contain a JSON object", { cause: error });
  }
}

async function runOperation(
  dependencies: CliDependencies,
  parsed: ParsedCliArguments,
  resume: boolean,
): Promise<number> {
  const application = dependencies.application;
  const startInput = {
    evidenceStoreDir: requiredOption(parsed, "store", dependencies.defaults?.evidenceStoreDir),
    planFingerprint: requiredOption(parsed, "plan"),
    targetPath: requiredOption(parsed, "target"),
    ...(option(parsed, "operation-id") === undefined ? {} : { operationId: option(parsed, "operation-id") }),
  };
  const operation = resume ? application.resumeExperiment(startInput) : application.startExperiment(startInput);
  let interrupted = false;
  const unsubscribe = dependencies.signals?.onSigint(() => {
    interrupted = true;
    void application.cancelOperation(operation.id).catch(() => undefined);
  });
  try {
    const state = await operation.completion;
    output(dependencies, parsed, state, `experiment ${state.planId}: ${state.status}`);
    return interrupted || state.status === "interrupted" ? 130 : 0;
  } finally {
    unsubscribe?.();
  }
}

async function dispatch(parsed: ParsedCliArguments, dependencies: CliDependencies): Promise<number> {
  const [command, subcommand] = parsed.positional;
  const application = dependencies.application;
  const defaults = dependencies.defaults ?? {};

  if (command === undefined) {
    if (dependencies.legacyMain) return dependencies.legacyMain([]);
    throw new ApplicationError("INVALID_ARGUMENT", "a command is required");
  }
  if (command === "legacy") {
    if (!dependencies.legacyMain) throw new ApplicationError("CAPABILITY_UNAVAILABLE", "legacy CLI adapter is not configured");
    return dependencies.legacyMain(parsed.raw.slice(1));
  }
  if (LEGACY_TOP_LEVEL.has(command)) {
    if (!dependencies.legacyMain) throw new ApplicationError("CAPABILITY_UNAVAILABLE", "legacy CLI adapter is not configured");
    return dependencies.legacyMain(parsed.raw);
  }
  if (command === "diagnostics" || command === "check") {
    const result = await application.diagnose({
      repoDir: requiredOption(parsed, "repo", defaults.repoDir),
      playbookDir: requiredOption(parsed, "playbook", defaults.playbookDir),
      evidenceStoreDir: requiredOption(parsed, "store", defaults.evidenceStoreDir),
      ...(option(parsed, "benchmarks", defaults.benchmarksDir) === undefined ? {} : { benchmarksDir: option(parsed, "benchmarks", defaults.benchmarksDir) }),
      ...(parsed.options.docker === true ? { includeDocker: true } : {}),
    });
    output(dependencies, parsed, result, renderDiagnostics(result));
    return result.ok ? 0 : CLI_EXIT_CODES.INFRASTRUCTURE_FAILURE;
  }
  if ((command === "prompts" && subcommand === "list") || command === "list") {
    const selector = command === "list" ? parsed.positional[1] : parsed.positional[2];
    const prompts = await application.discoverPrompts({
      playbookDir: requiredOption(parsed, "playbook", defaults.playbookDir),
      ...(selector === undefined ? {} : { selector }),
    });
    output(dependencies, parsed, prompts, prompts.map(({ definition, relativePath }) => `${definition.id}\t${relativePath}`).join("\n"));
    return 0;
  }
  if (command === "benchmarks" && subcommand === "list") {
    const selector = parsed.positional[2];
    const benchmarks = await application.discoverBenchmarks({
      playbookDir: requiredOption(parsed, "playbook", defaults.playbookDir),
      benchmarksDir: requiredOption(parsed, "benchmarks", defaults.benchmarksDir),
      ...(selector === undefined ? {} : { selector }),
    });
    output(dependencies, parsed, benchmarks, benchmarks.map(({ id, relativePath }) => `${id}\t${relativePath}`).join("\n"));
    return 0;
  }
  if (command === "experiment" && subcommand === "create") {
    const spec = parseSpec(parsed);
    const result = await application.createExperimentPlan({
      ...spec,
      evidenceStoreDir: option(parsed, "store", defaults.evidenceStoreDir) ?? spec.evidenceStoreDir,
    } as Parameters<LabApplication["createExperimentPlan"]>[0]);
    output(dependencies, parsed, result, `${result.planId}\t${result.planFingerprint}\t${result.plannedRunCount}`);
    return 0;
  }
  if (command === "cases" && subcommand === "generate") {
    const result = await application.generateCases(parseSpec(parsed) as unknown as Parameters<LabApplication["generateCases"]>[0]);
    output(dependencies, parsed, result, `${result.generationId}\t${result.status}\t${result.cases.length}`);
    return 0;
  }
  if (command === "experiment" && (subcommand === "run" || subcommand === "resume")) {
    return runOperation(dependencies, parsed, subcommand === "resume");
  }
  if (command === "experiment" && subcommand === "report") {
    const result = await application.buildReport({
      evidenceStoreDir: requiredOption(parsed, "store", defaults.evidenceStoreDir),
      planFingerprint: requiredOption(parsed, "plan"),
    });
    const format = option(parsed, "format", "markdown");
    if (isJson(parsed) || format === "json") writeLine(dependencies.stdout, result.json.trimEnd());
    else if (format === "markdown") dependencies.stdout.write(result.markdown);
    else throw new ApplicationError("INVALID_ARGUMENT", "--format must be json or markdown");
    return 0;
  }
  if (command === "review" && subcommand === "set") {
    const result = await application.reviewRun({
      evidenceStoreDir: requiredOption(parsed, "store", defaults.evidenceStoreDir),
      planFingerprint: requiredOption(parsed, "plan"),
      plannedRunId: requiredOption(parsed, "run"),
      status: requiredOption(parsed, "status") as Parameters<LabApplication["reviewRun"]>[0]["status"],
      reviewer: requiredOption(parsed, "reviewer"),
      ...(option(parsed, "reviewed-at") === undefined ? {} : { reviewedAt: option(parsed, "reviewed-at") }),
      ...(option(parsed, "comment") === undefined ? {} : { comment: option(parsed, "comment") }),
    });
    output(dependencies, parsed, result, `${result.plannedRunId}\t${result.status}\t${result.recordFingerprint}`);
    return 0;
  }
  if (command === "promote") {
    const result = await application.promoteCase({
      evidenceStoreDir: requiredOption(parsed, "store", defaults.evidenceStoreDir),
      benchmarksDir: requiredOption(parsed, "benchmarks", defaults.benchmarksDir),
      planFingerprint: requiredOption(parsed, "plan"),
      plannedRunId: requiredOption(parsed, "run"),
      fixedCaseId: requiredOption(parsed, "id"),
      title: requiredOption(parsed, "title"),
      expectation: requiredOption(parsed, "expectation") as "implementation" | "clarification",
      promotedBy: requiredOption(parsed, "by"),
      ...(option(parsed, "promoted-at") === undefined ? {} : { promotedAt: option(parsed, "promoted-at") }),
      ...(option(parsed, "comment") === undefined ? {} : { comment: option(parsed, "comment") }),
    });
    output(dependencies, parsed, result, `${result.audit.fixedCaseId}\t${result.audit.recordFingerprint}`);
    return 0;
  }
  if (command === "artifact" && subcommand === "show") {
    if (parsed.options.text === true && isJson(parsed)) {
      throw new ApplicationError("INVALID_ARGUMENT", "--text and --json cannot be combined");
    }
    const result = await application.readArtifact({
      evidenceStoreDir: requiredOption(parsed, "store", defaults.evidenceStoreDir),
      reference: requiredOption(parsed, "ref"),
    });
    if (parsed.options.text === true) dependencies.stdout.write(Buffer.from(result.bytesBase64, "base64").toString("utf8"));
    else output(dependencies, parsed, result, `${result.reference}\t${result.byteLength} bytes`);
    return 0;
  }
  throw new ApplicationError("INVALID_ARGUMENT", `unknown command: ${parsed.positional.join(" ")}`);
}

export async function main(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  let parsed: ParsedCliArguments | undefined;
  try {
    parsed = parseCliArguments(argv);
    return await dispatch(parsed, dependencies);
  } catch (error) {
    const mapped = error instanceof ApplicationError
      ? error
      : applicationError(error, "INTERNAL_ERROR", "unexpected CLI failure");
    writeLine(dependencies.stderr, renderApplicationError(mapped, parsed ? isJson(parsed) : argv.includes("--json")));
    return CLI_EXIT_CODES[mapped.code];
  }
}

export * from "./parser.js";
export * from "./render.js";
export * from "./bootstrap.js";
