import crypto from "node:crypto";

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") throw new TypeError("canonical JSON accepts only JSON values");
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Exact(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function deepFreezeCopy<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreezeCopy(entry);
  return Object.freeze(value);
}
