export const APPLICATION_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "CANCELLED",
  "INFRASTRUCTURE_FAILURE",
  "DATA_INTEGRITY_FAILURE",
  "INTERNAL_ERROR",
] as const;

export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];

export type ApplicationErrorCategory =
  | "usage"
  | "missing"
  | "state"
  | "capability"
  | "cancellation"
  | "infrastructure"
  | "data_integrity"
  | "internal";

const CATEGORIES: Readonly<Record<ApplicationErrorCode, ApplicationErrorCategory>> = {
  INVALID_ARGUMENT: "usage",
  NOT_FOUND: "missing",
  CONFLICT: "state",
  CAPABILITY_UNAVAILABLE: "capability",
  CANCELLED: "cancellation",
  INFRASTRUCTURE_FAILURE: "infrastructure",
  DATA_INTEGRITY_FAILURE: "data_integrity",
  INTERNAL_ERROR: "internal",
};

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly category: ApplicationErrorCategory;
  override readonly cause?: unknown;

  constructor(code: ApplicationErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.category = CATEGORIES[code];
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON(): { readonly code: ApplicationErrorCode; readonly category: ApplicationErrorCategory; readonly message: string } {
    return { code: this.code, category: this.category, message: this.message };
  }
}

export function applicationError(
  error: unknown,
  code: ApplicationErrorCode,
  message: string,
): ApplicationError {
  if (error instanceof ApplicationError) return error;
  return new ApplicationError(code, message, { cause: error });
}

export function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApplicationError("INVALID_ARGUMENT", `${field} must be explicitly provided`);
  }
  return value;
}

const INFRASTRUCTURE_ERRNOS = new Set([
  "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "EMFILE", "ENFILE",
  "EBUSY", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
]);

export function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? nodeErrorCode(error.cause) : undefined;
}

export function isInfrastructureError(error: unknown): boolean {
  return INFRASTRUCTURE_ERRNOS.has(nodeErrorCode(error) ?? "");
}

export function isNotFoundError(error: unknown): boolean {
  return nodeErrorCode(error) === "ENOENT";
}

export function requireSha256(value: string, field: string): string {
  requireNonEmpty(value, field);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ApplicationError("INVALID_ARGUMENT", `${field} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

export function mapLookupError(error: unknown, message: string): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof TypeError) return applicationError(error, "INVALID_ARGUMENT", message);
  if (isInfrastructureError(error)) return applicationError(error, "INFRASTRUCTURE_FAILURE", message);
  if (isNotFoundError(error)) return applicationError(error, "NOT_FOUND", message);
  return applicationError(error, "INTERNAL_ERROR", message);
}

export function mapIntegrityReadError(error: unknown, message: string): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (isInfrastructureError(error)) return applicationError(error, "INFRASTRUCTURE_FAILURE", message);
  if (isNotFoundError(error)) return applicationError(error, "NOT_FOUND", message);
  return applicationError(error, "DATA_INTEGRITY_FAILURE", message);
}
