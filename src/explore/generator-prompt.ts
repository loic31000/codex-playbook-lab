import crypto from "node:crypto";

export interface GeneratorPromptVersion {
  readonly id: string;
  readonly content: string;
  readonly fingerprint: string;
}

export function fingerprintExactText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function createGeneratorPromptVersion(input: {
  readonly id: string;
  readonly content: string;
  readonly fingerprint?: string;
}): GeneratorPromptVersion {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new TypeError("generatorPrompt.id must be a non-empty string");
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    throw new TypeError("generatorPrompt.content must be a non-empty string");
  }
  const fingerprint = fingerprintExactText(input.content);
  if (input.fingerprint !== undefined && input.fingerprint !== fingerprint) {
    throw new TypeError("generatorPrompt.fingerprint does not match generatorPrompt.content");
  }
  return Object.freeze({ id: input.id, content: input.content, fingerprint });
}
