import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { allocateReadableIds, fingerprintPrompt, normalizeRelativePath, promptIdentity } from './fingerprints.mjs';

export function hasPromptFrontmatter(markdown) {
  const frontmatter = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return Boolean(frontmatter && /^format\s*:\s*prompt\s*$/im.test(frontmatter));
}

export function extractPromptBlock(markdown) {
  if (!hasPromptFrontmatter(markdown)) return null;
  const match = markdown.match(/^## Prompt prêt à copier\s*\r?\n```(?:text)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m);
  return match?.[1]?.trim() || null;
}

async function markdownFiles(root) {
  const found = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(fullPath);
    }
  }
  await visit(root);
  return found;
}

export async function discoverPrompts(playbookDir, casesPerPrompt = 1) {
  const records = [];
  for (const fullPath of await markdownFiles(playbookDir)) {
    const markdown = await readFile(fullPath, 'utf8');
    const promptBlock = extractPromptBlock(markdown);
    if (!promptBlock) continue;
    const relativePath = normalizeRelativePath(path.relative(playbookDir, fullPath));
    for (let caseIndex = 1; caseIndex <= casesPerPrompt; caseIndex += 1) {
      const fingerprint = fingerprintPrompt(relativePath, promptBlock, caseIndex);
      records.push({ fullPath, relativePath, promptBlock, caseIndex, fingerprint,
        ...promptIdentity(relativePath, caseIndex, fingerprint) });
    }
  }
  return allocateReadableIds(records);
}

export function selectPrompt(prompts, selector) {
  if (!selector) return null;
  const normalized = normalizeRelativePath(selector).toLowerCase();
  const exact = prompts.filter((p) => p.id.toLowerCase() === normalized
    || p.relativePath.toLowerCase() === normalized
    || p.fullPath.toLowerCase() === selector.toLowerCase());
  if (exact.length === 1) return exact[0];
  const partial = prompts.filter((p) => p.id.toLowerCase().includes(normalized)
    || p.relativePath.toLowerCase().includes(normalized));
  if (partial.length === 1) return partial[0];
  if (exact.length + partial.length === 0) throw new Error(`Prompt introuvable : ${selector}`);
  throw new Error(`Sélection ambiguë : ${selector}`);
}
