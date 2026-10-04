import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverBenchmarks, fingerprintBenchmark, selectBenchmarks } from '../../src/core/benchmark-discovery.mjs';
import { initializeTestStorage } from '../../src/core/result-storage.mjs';
import { CodexRunError, runOneTest } from '../../src/core/test-runner.mjs';
import { runSuite } from '../../src/core/suite-runner.mjs';

const prompt = { id: '09-01-implementer-story', fingerprint: 'p'.repeat(64), promptBlock: 'Prompt versionné', relativePath: '09/01.md' };
const source = (overrides = {}) => `---\nformat: codex-lab-benchmark\nid: ${overrides.id ?? '001-test'}\nprompt: ${overrides.prompt ?? prompt.id}\ntitle: ${overrides.title ?? 'Test'}\nexpectation: ${overrides.expectation ?? 'implementation'}\n---\n\n# Cas stable\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-benchmarks-')); t.after(() => rm(root, { recursive: true, force: true }));
  const benchmarksDir = path.join(root, 'benchmarks'); await mkdir(benchmarksDir);
  return { root, benchmarksDir };
}

test('découverte benchmark, Markdown ordinaire ignoré et sélection sans hash', async (t) => {
  const { benchmarksDir } = await fixture(t);
  await writeFile(path.join(benchmarksDir, 'benchmark.md'), source());
  await writeFile(path.join(benchmarksDir, 'notes.md'), '---\ntitle: Notes ordinaires\ntags:\n  - documentation\n---\n\n# Notes ordinaires\n');
  const records = await discoverBenchmarks(benchmarksDir, [prompt]);
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'fixed-benchmark');
  assert.equal(records[0].id, '09-01-implementer-story--benchmark-001-test');
  assert.deepEqual(selectBenchmarks(records, prompt.id), records);
  assert.deepEqual(selectBenchmarks(records, records[0].id), records);
});

test('les trois benchmarks 09-01 versionnés sont découverts et déterministes', async () => {
  const records = await discoverBenchmarks(path.resolve('benchmarks'), [prompt]);
  assert.deepEqual(records.map((item) => item.benchmarkId), ['001-ajouter-tache', '002-priorite-ambiguite', '003-lister-taches']);
  assert.deepEqual(records.map((item) => item.expectation), ['implementation', 'clarification', 'implementation']);
  assert.doesNotMatch(records[1].caseText, /\b(?:low|medium|high)\b/i);
  assert.match(records[1].caseText, /expectation: clarification/);
  assert.doesNotMatch(records[1].executionText, /format: codex-lab-benchmark|expectation: clarification/);
});

test('frontmatter benchmark invalide, expectation inconnue et prompt absent sont refusés avant exécution', async (t) => {
  for (const [name, markdown, pattern] of [
    ['broken', '---\nformat: codex-lab-benchmark\nid: x\n', /Frontmatter/],
    ['expectation', source({ expectation: 'score-ai' }), /Expectation/],
    ['prompt', source({ prompt: '99-99-absent' }), /introuvable/],
    ['traversal', source({ id: '../outside' }), /ID benchmark invalide/],
  ]) {
    const directory = path.join((await fixture(t)).benchmarksDir, name); await mkdir(directory);
    await writeFile(path.join(directory, 'case.md'), markdown);
    await assert.rejects(discoverBenchmarks(directory, [prompt]), pattern);
  }
});

test('ID benchmark dupliqué refusé', async (t) => {
  const { benchmarksDir } = await fixture(t); await mkdir(path.join(benchmarksDir, 'nested'));
  await writeFile(path.join(benchmarksDir, 'a.md'), source());
  await writeFile(path.join(benchmarksDir, 'nested', 'b.md'), source());
  await assert.rejects(discoverBenchmarks(benchmarksDir, [prompt]), /dupliqué/);
});

test('fingerprint benchmark est stable et dépend du cas comme du prompt', () => {
  const a = fingerprintBenchmark('benchmarks/a.md', source(), prompt, 'implementation');
  assert.equal(a, fingerprintBenchmark('benchmarks/a.md', source(), prompt, 'implementation'));
  assert.notEqual(a, fingerprintBenchmark('benchmarks/a.md', `${source()}suite`, prompt, 'implementation'));
  assert.notEqual(a, fingerprintBenchmark('benchmarks/a.md', source(), { ...prompt, fingerprint: 'q'.repeat(64) }, 'implementation'));
});

test('benchmark fixe charge case.md à l’identique sans appel de génération', async (t) => {
  const { root, benchmarksDir } = await fixture(t); const markdown = source();
  await writeFile(path.join(benchmarksDir, 'case.md'), markdown);
  const [record] = await discoverBenchmarks(benchmarksDir, [prompt]);
  const calls = []; const labels = [];
  const result = await runOneTest({ repoDir: root, resultsDir: path.join(root, 'results') }, record, {
    assertSafeImpl: async () => {}, restoreImpl: async () => {},
    runCodexImpl: async ({ input, outputDir }) => { calls.push(input); await mkdir(outputDir, { recursive: true }); return { success: true, exitStatus: 0, elapsedSeconds: 1, finalContent: 'fait', stdout: '', stderr: '' }; },
    saveValidateImpl: async ({ label }) => { labels.push(label); return { tests: 0, typescript: 0, diffCheck: 0, changedFiles: 1 }; },
    compareImpl: async (_a, _b, output) => writeFile(output, 'diff'),
  });
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 2);
  assert.deepEqual(labels, ['BASELINE', 'AVEC PROMPT']);
  assert.equal(await readFile(result.paths.caseFile, 'utf8'), markdown);
  for (const input of calls) {
    assert.match(input, /# Cas stable/);
    assert.doesNotMatch(input, /format: codex-lab-benchmark|expectation: implementation/);
  }
  assert.match(await readFile(result.paths.result, 'utf8'), /Type : benchmark fixe[\s\S]*Attente : implementation/);
  assert.notEqual(record.id, prompt.id);
});

test('benchmark clarification accepte zéro modification sans masquer les erreurs techniques', async (t) => {
  const { root } = await fixture(t);
  const record = (await discoverBenchmarks(path.resolve('benchmarks'), [prompt]))
    .find((item) => item.benchmarkId === '002-priorite-ambiguite');
  const calls = [];
  const result = await runOneTest({ repoDir: root, resultsDir: path.join(root, 'results') }, record, {
    assertSafeImpl: async () => {}, restoreImpl: async () => {},
    runCodexImpl: async ({ input, outputDir }) => { calls.push(input); await mkdir(outputDir, { recursive: true }); return { success: true, exitStatus: 0, elapsedSeconds: 1, finalContent: 'Les valeurs métier manquent. Quelles valeurs souhaitez-vous ?', stdout: '', stderr: '' }; },
    saveValidateImpl: async () => ({ tests: 0, typescript: 0, diffCheck: 0, changedFiles: 0 }),
    compareImpl: async (_a, _b, output) => writeFile(output, '(Aucune différence)\n'),
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 2);
  for (const input of calls) {
    assert.match(input, /priorit/i);
    assert.doesNotMatch(input, /format: codex-lab-benchmark|expectation: clarification/);
  }
  const readOnly = new CodexRunError('x', { success: true, stderr: '', environmentWriteBlocked: true });
  const rateLimit = new CodexRunError('x', { success: false, stderr: 'HTTP 429 too many requests' });
  const interrupted = new CodexRunError('x', { success: false, stderr: '', interrupted: true, interruptionSignal: 'SIGINT' });
  assert.equal(readOnly.environment, true); assert.equal(rateLimit.rateLimit, true); assert.equal(interrupted.result.interrupted, true);
});

test('reprise fixe valide évite tout appel et changement de fingerprint archive sans supprimer', async (t) => {
  const { root } = await fixture(t); const resultsDir = path.join(root, 'results');
  const record = { ...prompt, kind: 'fixed-benchmark', benchmarkId: '001-test', promptId: prompt.id,
    id: `${prompt.id}--benchmark-001-test`, legacyId: 'benchmark-old', displayName: 'Benchmark',
    caseText: source(), expectation: 'implementation', sourcePath: 'benchmarks/case.md', fingerprint: 'a'.repeat(64) };
  const paths = await initializeTestStorage(resultsDir, record); await writeFile(paths.caseFile, record.caseText);
  for (const directory of [paths.base, paths.prompt]) {
    await mkdir(directory); await writeFile(path.join(directory, 'codex-log.txt'), 'log');
    await writeFile(path.join(directory, 'codex-final.txt'), 'ok'); await writeFile(path.join(directory, 'codex-exit-code.txt'), '0');
  }
  await writeFile(paths.comparison, 'diff'); await writeFile(paths.result, 'result');
  let calls = 0; const skipped = await runOneTest({ repoDir: root, resultsDir }, record, { runCodexImpl: async () => { calls += 1; } });
  assert.equal(skipped.status, 'skipped'); assert.equal(calls, 0);
  await initializeTestStorage(resultsDir, { ...record, fingerprint: 'b'.repeat(64), legacyId: 'benchmark-new' });
  const archives = await import('node:fs/promises').then((fs) => fs.readdir(path.join(resultsDir, '_archive')));
  assert.equal(archives.length, 1);
});

test('manifest distingue cas généré et benchmark fixe', async (t) => {
  const { root, benchmarksDir } = await fixture(t); await writeFile(path.join(benchmarksDir, 'case.md'), source());
  const [benchmark] = await discoverBenchmarks(benchmarksDir, [prompt]);
  const generated = { ...prompt, kind: 'generated', displayName: 'Généré', caseIndex: 1, legacyId: 'auto-prompt' };
  await runSuite({ resultsDir: path.join(root, 'results') }, { prepared: { prompts: [generated, benchmark], selected: [] } });
  const manifest = JSON.parse(await readFile(path.join(root, 'results', 'generated-manifest.json'), 'utf8'));
  assert.equal(manifest[0].kind, 'generated'); assert.equal(manifest[1].kind, 'fixed-benchmark');
  assert.equal(manifest[1].expectation, 'implementation'); assert.match(manifest[1].source, /^benchmarks\//);
});
