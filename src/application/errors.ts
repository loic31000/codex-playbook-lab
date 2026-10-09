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
