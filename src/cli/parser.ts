import { ApplicationError } from "../application/index.js";

export interface ParsedCliArguments {
  readonly raw: readonly string[];
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

const BOOLEAN_OPTIONS = new Set(["json", "docker", "text", "yes", "select-only"]);

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (key === "") throw new ApplicationError("INVALID_ARGUMENT", "empty option is not supported");
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new ApplicationError("INVALID_ARGUMENT", `--${key} requires a value`);
    }
    options[key] = value;
  }
  return { raw: [...argv], positional, options };
}

export function option(
  parsed: ParsedCliArguments,
  name: string,
  fallback?: string,
): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : fallback;
}

export function requiredOption(parsed: ParsedCliArguments, name: string, fallback?: string): string {
  const value = option(parsed, name, fallback);
  if (!value) throw new ApplicationError("INVALID_ARGUMENT", `--${name} is required`);
  return value;
}
