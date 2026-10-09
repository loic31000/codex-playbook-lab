import {
  ApplicationError,
  type ApplicationErrorCode,
  type DiagnosticResult,
} from "../application/index.js";

export const CLI_EXIT_CODES: Readonly<Record<ApplicationErrorCode, number>> = {
  INVALID_ARGUMENT: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  CAPABILITY_UNAVAILABLE: 5,
  CANCELLED: 130,
  INFRASTRUCTURE_FAILURE: 5,
  DATA_INTEGRITY_FAILURE: 5,
  INTERNAL_ERROR: 1,
};

export interface CliWriter {
  write(value: string): void;
}

export function writeLine(writer: CliWriter, value: string): void {
  writer.write(`${value}\n`);
}

export function writeJson(writer: CliWriter, value: unknown): void {
  writeLine(writer, JSON.stringify(value));
}

export function renderApplicationError(error: ApplicationError, json: boolean): string {
  return json
    ? JSON.stringify({ error: error.toJSON() })
    : `${error.code}: ${error.message}`;
}

export function renderDiagnostics(result: DiagnosticResult): string {
  return result.checks.map(({ id, status, message }) => `${status.toUpperCase()}\t${id}\t${message}`).join("\n");
}
