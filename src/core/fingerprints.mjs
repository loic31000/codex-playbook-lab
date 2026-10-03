import { createHash } from 'node:crypto';
import path from 'node:path';

export function normalizeRelativePath(value) {
  return value.split(path.sep).join('/').replaceAll('\\', '/');
}

export function fingerprintPrompt(relativePath, promptBlock, caseIndex) {
  // Canonicalise to the historical PowerShell-on-Windows representation so
  // existing fingerprints and auto-* directories remain resumable everywhere.
  const historicalPath = normalizeRelativePath(relativePath).replaceAll('/', '\\');
  const payload = `${historicalPath}\r\n${promptBlock}\r\n${caseIndex}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function slugify(value, maxLength = 26) {
  const slug = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (slug.slice(0, maxLength).replace(/-$/g, '') || 'prompt');
}

export function promptIdentity(relativePath, caseIndex, fingerprint) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split('/');
  const section = (parts[0]?.match(/^(\d+)/)?.[1] ?? '00').padStart(2, '0');
  const stem = path.posix.basename(normalized, path.posix.extname(normalized));
  const match = stem.match(/^(\d+)\s*-\s*(.+)$/);
  const item = (match?.[1] ?? String(caseIndex)).padStart(2, '0');
  const title = match?.[2] ?? stem;
  return {
    idBase: `${section}-${item}-${slugify(title)}${caseIndex > 1 ? `-c${caseIndex}` : ''}`,
    displayName: `${section}-${item} ${title}`,
    legacyId: `auto-${fingerprint.slice(0, 12)}`,
  };
}

export function allocateReadableIds(records) {
  const counts = new Map();
  return records.map((record) => {
    const count = (counts.get(record.idBase) ?? 0) + 1;
    counts.set(record.idBase, count);
    return { ...record, id: count === 1 ? record.idBase : `${record.idBase}-${count}` };
  });
}
