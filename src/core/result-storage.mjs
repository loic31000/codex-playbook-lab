import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function exists(target) { try { await stat(target); return true; } catch { return false; } }

export function testPaths(resultsDir, test) {
  const root = path.join(resultsDir, test.id);
  return { root, fingerprint: path.join(root, 'fingerprint.txt'), caseFile: path.join(root, 'case.md'), generationLog: path.join(root, 'generation.log'), result: path.join(root, 'result.md'), comparison: path.join(root, 'diff.patch'), base: path.join(root, 'base'), prompt: path.join(root, 'prompt') };
}

export async function readRunStatus(runDir) {
  if (!(await exists(runDir))) return { valid: false, reason: 'missing' };
  let raw; let finalContent = '';
  try { raw = (await readFile(path.join(runDir, 'codex-exit-code.txt'), 'utf8')).trim(); } catch { return { valid: false, reason: 'missing-exit' }; }
  try { await stat(path.join(runDir, 'codex-log.txt')); } catch { return { valid: false, reason: 'missing-log' }; }
  try { finalContent = await readFile(path.join(runDir, 'codex-final.txt'), 'utf8'); } catch {}
  const codexStatusPresent = await exists(path.join(runDir, 'codex-status.json'));
  const summaryPresent = await exists(path.join(runDir, 'summary.json'));
  let codexStatus = null; let summary = null;
  try { codexStatus = JSON.parse(await readFile(path.join(runDir, 'codex-status.json'), 'utf8')); } catch {}
  try { summary = JSON.parse(await readFile(path.join(runDir, 'summary.json'), 'utf8')); } catch {}
  const modern = codexStatusPresent || summaryPresent;
  const exitStatus = /^-?\d+$/.test(raw) ? Number(raw) : 'unknown';

  if (!modern) {
    if (Number.isInteger(exitStatus)) return { valid: exitStatus === 0, exitStatus, fallback: false, legacy: true };
    const fallback = (raw === 'unknown' || raw === '') && finalContent.trim().length > 0;
    return { valid: fallback, exitStatus: 'unknown', fallback, legacy: true,
      ...(!fallback ? { reason: 'legacy-unknown-without-final' } : {}) };
  }

  if (!codexStatus) return { valid: false, reason: codexStatusPresent ? 'invalid-codex-status' : 'missing-codex-status', exitStatus };
  if (!summary) return { valid: false, reason: summaryPresent ? 'invalid-summary' : 'missing-summary', exitStatus };
  const fallbackAllowed = exitStatus === 'unknown' && raw === 'unknown'
    && codexStatus.fallback === true && codexStatus.success === true && finalContent.trim().length > 0;
  const codexSucceeded = (exitStatus === 0 && codexStatus.success === true) || fallbackAllowed;
  const classifications = summary.classifications;
  const acceptable = new Set(['passed', 'environment-limitation']);
  const classificationValid = (code, classification) => (classification === 'passed' && code === 0)
    || classification === 'environment-limitation';
  const validationsSucceeded = summary.diffCheck === 0 && classifications
    && acceptable.has(classifications.tests) && acceptable.has(classifications.typescript)
    && classificationValid(summary.tests, classifications.tests)
    && classificationValid(summary.typescript, classifications.typescript);
  return { valid: Boolean(codexSucceeded && validationsSucceeded), exitStatus,
    fallback: fallbackAllowed, legacy: false,
    ...(!codexSucceeded ? { reason: 'codex-failed' } : !validationsSucceeded ? { reason: 'validation-failed' } : {}) };
}

async function uniqueArchivePath(resultsDir, name) {
  const archive = path.join(resultsDir, '_archive'); await mkdir(archive, { recursive: true });
  for (let i = 1; ; i += 1) {
    const candidate = path.join(archive, `${name}-${String(i).padStart(3, '0')}`);
    if (!(await exists(candidate))) return candidate;
  }
}

export async function initializeTestStorage(resultsDir, test) {
  await mkdir(resultsDir, { recursive: true });
  const paths = testPaths(resultsDir, test);
  const legacy = path.join(resultsDir, test.legacyId);
  let recognizedLegacyMigration = false;
  if (!(await exists(paths.root)) && await exists(legacy)) {
    await rename(legacy, paths.root); recognizedLegacyMigration = true;
  }
  if (await exists(paths.root)) {
    let stored = '';
    try { stored = (await readFile(paths.fingerprint, 'utf8')).trim(); } catch {}
    if (stored && stored !== test.fingerprint) {
      await rename(paths.root, await uniqueArchivePath(resultsDir, test.id));
    } else if (!stored && !recognizedLegacyMigration && (await readdir(paths.root)).length > 0) {
      await rename(paths.root, await uniqueArchivePath(resultsDir, `${test.id}-sans-fingerprint`));
    }
  }
  await mkdir(paths.root, { recursive: true });
  const legacyArtifacts = [
    [`${test.legacyId}-baseline`, paths.base],
    [`${test.legacyId}-with-prompt`, paths.prompt],
    [`${test.legacyId}-comparison.diff`, paths.comparison],
    [`${test.legacyId}-result.md`, paths.result],
    [`${test.legacyId}-suite.log`, path.join(paths.root, 'suite.log')],
  ];
  for (const [legacyName, destination] of legacyArtifacts) {
    const source = path.join(resultsDir, legacyName);
    if (await exists(source) && !(await exists(destination))) await rename(source, destination);
  }
  const legacyGenerationLog = path.join(resultsDir, 'generated-cases', `${test.legacyId}-generation.log`);
  if (await exists(legacyGenerationLog) && !(await exists(paths.generationLog))) await rename(legacyGenerationLog, paths.generationLog);
  await writeFile(paths.fingerprint, `${test.fingerprint}\n`, 'utf8');
  return paths;
}

export async function migrateLegacyGeneratedCase(resultsDir, test, paths) {
  if (await exists(paths.caseFile)) return false;
  const candidates = [
    path.join(resultsDir, 'generated-cases', `${test.legacyId}.md`),
    path.join(resultsDir, `${test.legacyId}.md`),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) { await cp(candidate, paths.caseFile, { errorOnExist: true, force: false }); return true; }
  }
  return false;
}

export async function getResumeState(paths) {
  const [base, prompt] = await Promise.all([readRunStatus(paths.base), readRunStatus(paths.prompt)]);
  const comparison = await exists(paths.comparison);
  const caseReady = await exists(paths.caseFile);
  const result = await exists(paths.result);
  return { caseReady, base, prompt, comparison, result,
    complete: caseReady && base.valid && prompt.valid && comparison && result };
}

export async function removeInvalidRun(runDir) {
  const status = await readRunStatus(runDir);
  if (!status.valid && status.reason !== 'missing') await rm(runDir, { recursive: true, force: true });
}

export async function cleanResultsSafely(resultsDir, configuredResultsDir, protectedDirs = []) {
  const target = path.resolve(resultsDir); const configured = path.resolve(configuredResultsDir);
  if (target !== configured || path.parse(target).root === target) throw new Error('Nettoyage refusé : destination non configurée ou trop large.');
  for (const protectedDir of protectedDirs.map((x) => path.resolve(x))) {
    const relative = path.relative(target, protectedDir);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(`Nettoyage refusé : la cible contient un dossier protégé (${protectedDir}).`);
    }
  }
  await rm(target, { recursive: true, force: true });
}

export async function listResultDirectories(resultsDir) {
  try { return (await readdir(resultsDir, { withFileTypes: true })).filter((x) => x.isDirectory() && !x.name.startsWith('_')).map((x) => x.name); }
  catch { return []; }
}
