import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../experiment/canonical-json.js";
import type { ArtifactReference } from "./schema.js";

function sha256Bytes(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function asBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

async function readIfPresent(filename: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeOnceAtomic(
  filename: string,
  value: string | Uint8Array,
  description: string,
): Promise<"written" | "existing"> {
  const bytes = asBuffer(value);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const existing = await readIfPresent(filename);
  if (existing) {
    if (!existing.equals(bytes)) throw new Error(`${description} already exists with different content`);
    return "existing";
  }

  const temporary = path.join(
    path.dirname(filename),
    `.tmp-${path.basename(filename)}-${process.pid}-${crypto.randomUUID()}`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await fs.readFile(filename);
      if (!concurrent.equals(bytes)) throw new Error(`${description} already exists with different content`);
      return "existing";
    }
    return "written";
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function writeOnceCanonicalJson(filename: string, value: unknown, description: string): Promise<void> {
  await writeOnceAtomic(filename, `${canonicalJson(value)}\n`, description);
}

export class ContentAddressedBlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(value: string | Uint8Array, mediaType: string): Promise<ArtifactReference> {
    if (typeof mediaType !== "string" || mediaType.trim() === "") {
      throw new TypeError("artifact mediaType must be a non-empty string");
    }
    const bytes = asBuffer(value);
    const sha256 = sha256Bytes(bytes);
    const ref = `blobs/sha256/${sha256}`;
    await writeOnceAtomic(path.join(this.root, ...ref.split("/")), bytes, `blob ${sha256}`);
    return { sha256, byteLength: bytes.byteLength, mediaType, ref };
  }

  async read(reference: ArtifactReference | string): Promise<Buffer> {
    const ref = typeof reference === "string" ? reference : reference.ref;
    if (!/^blobs\/sha256\/[a-f0-9]{64}$/.test(ref)) throw new TypeError("invalid portable blob reference");
    const bytes = await fs.readFile(path.join(this.root, ...ref.split("/")));
    const expected = ref.slice("blobs/sha256/".length);
    if (sha256Bytes(bytes) !== expected) throw new Error(`blob ${expected} content does not match its reference`);
    if (typeof reference !== "string") {
      if (reference.sha256 !== expected || reference.byteLength !== bytes.byteLength) {
        throw new Error(`blob ${expected} metadata does not match its content`);
      }
    }
    return bytes;
  }
}
