import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createPromptDefinition,
  createPromptVersion,
  type PromptDefinition,
  type PromptVersion,
} from "../domain/index.js";

export interface DiscoveredPrompt {
  readonly definition: PromptDefinition;
  readonly version: PromptVersion;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sourceFingerprint: string;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/").replaceAll("\\", "/");
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "prompt";
}

function promptDefinitionId(relativePath: string): string {
  const normalized = portablePath(relativePath);
  const segments = normalized.split("/");
  const section = (segments[0]?.match(/^(\d+)/)?.[1] ?? "00").padStart(2, "0");
  const stem = path.posix.basename(normalized, path.posix.extname(normalized));
  const match = stem.match(/^(\d+)\s*-\s*(.+)$/);
  const item = (match?.[1] ?? "00").padStart(2, "0");
  return `${section}-${item}-${slugify(match?.[2] ?? stem)}`;
}

function frontmatterFields(markdown: string): Readonly<Record<string, string>> | null {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (entry) fields[entry[1]!.toLowerCase()] = entry[2]!;
  }
  return fields;
}

function extractPromptContent(markdown: string, sourcePath: string): string | null {
  const fields = frontmatterFields(markdown);
  if (fields?.format !== "prompt") return null;
  const match = markdown.match(
    /^## Prompt prêt à copier[ \t]*\r?\n(?:[ \t]*\r?\n)*```(?:text)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/m,
  );
  if (!match || match[1]!.trim() === "") {
    throw new Error(`Prompt sans bloc "Prompt prêt à copier" exploitable : ${sourcePath}`);
  }
  return match[1]!;
}

async function markdownFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort((left, right) => portablePath(path.relative(root, left)).localeCompare(
    portablePath(path.relative(root, right)),
    "en",
    { numeric: true },
  ));
}

export async function discoverPrompts(playbookDir: string): Promise<readonly DiscoveredPrompt[]> {
  if (typeof playbookDir !== "string" || playbookDir.trim() === "") {
    throw new TypeError("playbookDir must be explicitly provided");
  }
  const root = await fs.realpath(path.resolve(playbookDir));
  if (!(await fs.stat(root)).isDirectory()) throw new TypeError("playbookDir must reference a directory");

  const prompts: DiscoveredPrompt[] = [];
  const ids = new Set<string>();
  for (const sourcePath of await markdownFiles(root)) {
    const markdown = await fs.readFile(sourcePath, "utf8");
    const relativePath = portablePath(path.relative(root, sourcePath));
    const content = extractPromptContent(markdown, relativePath);
    if (content === null) continue;
    const fields = frontmatterFields(markdown)!;
    const id = promptDefinitionId(relativePath);
    if (ids.has(id)) throw new Error(`Prompt dupliqué ${id} : ${relativePath}`);
    ids.add(id);
    const fingerprint = sha256(content);
    const definition = createPromptDefinition({
      id,
      name: fields.titre?.trim() || path.posix.basename(relativePath, path.posix.extname(relativePath)),
    });
    const version = createPromptVersion({
      id: `${id}@${fingerprint.slice(0, 16)}`,
      promptDefinitionId: id,
      content,
      fingerprint,
    });
    prompts.push({
      definition,
      version,
      sourcePath,
      relativePath,
      sourceFingerprint: sha256(markdown),
    });
  }
  return prompts;
}

export function selectPrompts(
  prompts: readonly DiscoveredPrompt[],
  selector?: string,
): readonly DiscoveredPrompt[] {
  if (selector === undefined) return [...prompts];
  if (selector.trim() === "") throw new TypeError("prompt selector must not be empty");
  const selected = prompts.filter(({ definition, version, relativePath }) => (
    definition.id === selector || version.id === selector || relativePath === portablePath(selector)
  ));
  if (selected.length === 0) throw new Error(`Prompt introuvable : ${selector}`);
  if (selected.length > 1) throw new Error(`Sélection de prompt ambiguë : ${selector}`);
  return selected;
}
