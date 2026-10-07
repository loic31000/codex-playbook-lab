import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createTestCase, type FixedCase } from "../domain/index.js";
import type { DiscoveredPrompt } from "./prompt-discovery.js";

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXPECTATIONS = ["implementation", "clarification"] as const;

export type FixedBenchmarkExpectation = (typeof EXPECTATIONS)[number];

export interface FixedBenchmarkDefinition {
  readonly id: string;
  readonly testCase: FixedCase;
  readonly promptDefinitionId: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sourceFingerprint: string;
  readonly expectation: FixedBenchmarkExpectation;
}

interface ParsedBenchmark {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/").replaceAll("\\", "/");
}

function parseBenchmark(markdown: string, sourcePath: string): ParsedBenchmark {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) throw new Error(`Frontmatter benchmark mal formé : ${sourcePath}`);
  const fields: Record<string, string> = {};
  const allowed = new Set(["format", "id", "prompt", "title", "expectation"]);
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!entry) throw new Error(`Frontmatter benchmark mal formé (${sourcePath}) : ${line}`);
    const key = entry[1]!.toLowerCase();
    if (!allowed.has(key)) throw new Error(`Champ benchmark inconnu (${sourcePath}) : ${key}`);
    if (Object.hasOwn(fields, key)) throw new Error(`Champ benchmark dupliqué (${sourcePath}) : ${key}`);
    fields[key] = entry[2]!;
  }
  if (fields.format !== "codex-lab-benchmark") {
    throw new Error(`Format benchmark incorrect (${sourcePath}) : ${fields.format || "(vide)"}`);
  }
  return { fields, body: markdown.slice(match[0].length).trim() };
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

function requiredSafeId(value: string | undefined, field: string, sourcePath: string): string {
  if (!value || !SAFE_ID.test(value)) {
    throw new Error(`${field} benchmark manquant ou invalide (${sourcePath}) : ${value || "(vide)"}`);
  }
  return value;
}

export async function discoverFixedBenchmarks(
  benchmarksDir: string,
  prompts: readonly DiscoveredPrompt[],
): Promise<readonly FixedBenchmarkDefinition[]> {
  if (typeof benchmarksDir !== "string" || benchmarksDir.trim() === "") {
    throw new TypeError("benchmarksDir must be explicitly provided");
  }
  const root = await fs.realpath(path.resolve(benchmarksDir));
  if (!(await fs.stat(root)).isDirectory()) throw new TypeError("benchmarksDir must reference a directory");
  const promptIds = new Set(prompts.map(({ definition }) => definition.id));
  const ids = new Set<string>();
  const benchmarks: FixedBenchmarkDefinition[] = [];

  for (const sourcePath of await markdownFiles(root)) {
    const markdown = await fs.readFile(sourcePath, "utf8");
    const relativePath = portablePath(path.relative(root, sourcePath));
    const { fields, body } = parseBenchmark(markdown, relativePath);
    const caseId = requiredSafeId(fields.id, "ID", relativePath);
    const promptDefinitionId = requiredSafeId(fields.prompt, "Prompt", relativePath);
    if (!promptIds.has(promptDefinitionId)) {
      throw new Error(`Prompt benchmark introuvable (${relativePath}) : ${promptDefinitionId}`);
    }
    if (!fields.title?.trim()) throw new Error(`Titre benchmark manquant : ${relativePath}`);
    if (body === "") throw new Error(`Body benchmark vide : ${relativePath}`);
    if (!EXPECTATIONS.includes(fields.expectation as FixedBenchmarkExpectation)) {
      throw new Error(`Expectation benchmark inconnue (${relativePath}) : ${fields.expectation || "(vide)"}`);
    }
    const id = `${promptDefinitionId}--benchmark-${caseId}`;
    if (ids.has(id)) throw new Error(`Benchmark dupliqué ${id} : ${relativePath}`);
    ids.add(id);
    const testCase = createTestCase({ kind: "fixed", id: caseId, title: fields.title.trim(), input: body });
    if (testCase.kind !== "fixed") throw new Error(`Type de benchmark inattendu : ${relativePath}`);
    benchmarks.push({
      id,
      testCase,
      promptDefinitionId,
      sourcePath,
      relativePath,
      sourceFingerprint: sha256(markdown),
      expectation: fields.expectation as FixedBenchmarkExpectation,
    });
  }
  return benchmarks;
}

export function selectFixedBenchmarks(
  benchmarks: readonly FixedBenchmarkDefinition[],
  selector?: string,
): readonly FixedBenchmarkDefinition[] {
  if (selector === undefined) return [...benchmarks];
  if (selector.trim() === "") throw new TypeError("benchmark selector must not be empty");
  const exact = benchmarks.filter(({ id }) => id === selector);
  if (exact.length === 1) return exact;
  const byPrompt = benchmarks.filter(({ promptDefinitionId }) => promptDefinitionId === selector);
  if (byPrompt.length > 0) return byPrompt;
  throw new Error(`Benchmark ou prompt introuvable : ${selector}`);
}
