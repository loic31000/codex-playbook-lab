import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRelativePath } from './fingerprints.mjs';

const allowedExpectations = new Set(['implementation', 'clarification']);
const safeId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseFrontmatter(markdown, sourcePath) {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    if (/format\s*:\s*codex-lab-benchmark/i.test(markdown)) throw new Error(`Frontmatter benchmark invalide : ${sourcePath}`);
    return null;
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = line.match(/^([a-z_]+)\s*:\s*(.*?)\s*$/i);
    if (!entry) throw new Error(`Frontmatter benchmark invalide (${sourcePath}) : ${line}`);
    const key = entry[1].toLowerCase();
    if (Object.hasOwn(fields, key)) throw new Error(`Champ benchmark dupliqué (${sourcePath}) : ${key}`);
    fields[key] = entry[2];
  }
  return { fields, body: markdown.slice(match[0].length) };
}

async function markdownFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(fullPath);
    }
  }
  await visit(root); return files;
}

export function fingerprintBenchmark(relativePath, markdown, prompt, expectation) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const payload = `${normalizeRelativePath(relativePath)}\n${normalized}\n${prompt.id}\n${prompt.fingerprint}\n${prompt.promptBlock}\n${expectation}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export async function discoverBenchmarks(benchmarksDir, prompts) {
  if (!benchmarksDir) return [];
  const promptById = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const records = []; const ids = new Set();
  for (const fullPath of await markdownFiles(benchmarksDir)) {
    const markdown = await readFile(fullPath, 'utf8');
    const parsed = parseFrontmatter(markdown, normalizeRelativePath(path.relative(benchmarksDir, fullPath)));
    if (!parsed || parsed.fields.format !== 'codex-lab-benchmark') continue;
    const { id: benchmarkId, prompt: promptId, title, expectation } = parsed.fields;
    const sourcePath = normalizeRelativePath(path.relative(path.dirname(benchmarksDir), fullPath));
    if (!safeId.test(benchmarkId ?? '')) throw new Error(`ID benchmark invalide (${sourcePath}) : ${benchmarkId ?? '(vide)'}`);
    if (!safeId.test(promptId ?? '')) throw new Error(`ID prompt benchmark invalide (${sourcePath}) : ${promptId ?? '(vide)'}`);
    if (!title?.trim()) throw new Error(`Titre benchmark manquant : ${sourcePath}`);
    if (!allowedExpectations.has(expectation)) throw new Error(`Expectation benchmark inconnue (${sourcePath}) : ${expectation ?? '(vide)'}`);
    const prompt = promptById.get(promptId);
    if (!prompt) throw new Error(`Prompt benchmark introuvable (${sourcePath}) : ${promptId}`);
    const uniqueKey = `${promptId}/${benchmarkId}`;
    if (ids.has(uniqueKey)) throw new Error(`Benchmark dupliqué : ${uniqueKey}`);
    ids.add(uniqueKey);
    const fingerprint = fingerprintBenchmark(sourcePath, markdown, prompt, expectation);
    records.push({ ...prompt, kind: 'fixed-benchmark', benchmarkId, promptId,
      id: `${promptId}--benchmark-${benchmarkId}`, legacyId: `benchmark-${fingerprint.slice(0, 12)}`,
      displayName: `${promptId} / Benchmark ${benchmarkId.match(/^\d+/)?.[0] ?? benchmarkId} - ${title.trim()}`,
      caseText: markdown, expectation, sourcePath, benchmarkSource: fullPath, fingerprint });
  }
  return records;
}

export function selectBenchmarks(benchmarks, selector) {
  if (!selector) return benchmarks;
  const exactBenchmark = benchmarks.filter((item) => item.id === selector);
  if (exactBenchmark.length === 1) return exactBenchmark;
  const byPrompt = benchmarks.filter((item) => item.promptId === selector);
  if (byPrompt.length) return byPrompt;
  throw new Error(`Benchmark ou prompt introuvable : ${selector}`);
}
