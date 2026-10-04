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

test('les dix benchmarks 09-01 versionnés sont découverts et déterministes', async () => {
  const records = await discoverBenchmarks(path.resolve('benchmarks'), [prompt]);
  assert.deepEqual(records.map((item) => item.benchmarkId), [
    '001-ajouter-tache', '002-priorite-ambiguite', '003-lister-taches', '004-renommer-contrat-mutation',
    '005-rechercher-contrat-absence', '006-titre-bornes-1-80', '007-recherche-absence-hors-perimetre',
    '008-api-publique-index', '009-validation-titre-partagee', '010-priorite-contrat-complet-multifichier',
  ]);
  assert.deepEqual(records.map((item) => item.expectation), [
    'implementation', 'clarification', 'implementation', 'clarification', 'clarification', 'implementation', 'implementation',
    'implementation', 'implementation', 'implementation',
  ]);
  const priorityAmbiguity = records[1];
  assert.match(priorityAmbiguity.caseText, /expectation: clarification/);
  assert.match(priorityAmbiguity.executionText, /attribuer une priorité à une tâche/i);
  assert.match(priorityAmbiguity.executionText, /si aucune priorité n['’]est fournie[^;\n]*priorité par défaut/i);
  assert.doesNotMatch(priorityAmbiguity.executionText, /format: codex-lab-benchmark|expectation: clarification/);
  assert.doesNotMatch(priorityAmbiguity.executionText, /\b(?:low|medium|high)\b/i);
  assert.doesNotMatch(priorityAmbiguity.executionText, /ne sont pas définies|non définies|information manquante|ambiguïté|clarification nécessaire/i);

  const renameAmbiguity = records[3];
  assert.match(renameAmbiguity.caseText, /expectation: clarification/);
  assert.match(renameAmbiguity.executionText, /renommer une tâche existante/i);
  assert.match(renameAmbiguity.executionText, /fonction publique `renameTask\(task, newTitle\)`/i);
  assert.match(renameAmbiguity.executionText, /`newTitle` est normalisé avec `trim\(\)`/i);
  assert.match(renameAmbiguity.executionText, /titre vide après normalisation est refusé/i);
  assert.match(renameAmbiguity.executionText, /identifiant de la tâche est conservé/i);
  assert.match(renameAmbiguity.executionText, /valeur de `completed` est conservée/i);
  assert.match(renameAmbiguity.executionText, /fonction retourne une `Task`/i);
  assert.doesNotMatch(renameAmbiguity.executionText, /format: codex-lab-benchmark|expectation: clarification/);
  assert.doesNotMatch(renameAmbiguity.executionText, /mutation|muter|nouvel objet|nouveau objet|même instance|nouvelle instance|copie|identité|référence|ambiguïté|clarification|information manquante|ne sont pas définies|non définies/i);

  const absenceAmbiguity = records[4];
  assert.match(absenceAmbiguity.caseText, /expectation: clarification/);
  assert.match(absenceAmbiguity.executionText, /findTaskById\(tasks, id\)/);
  assert.match(absenceAmbiguity.executionText, /lorsqu’une tâche possède l’identifiant demandé, cette tâche est retournée/i);
  assert.match(absenceAmbiguity.executionText, /lorsqu’aucune tâche ne possède l’identifiant demandé est couvert par un test automatisé/i);
  assert.doesNotMatch(absenceAmbiguity.executionText, /format: codex-lab-benchmark|expectation: clarification/);
  assert.doesNotMatch(absenceAmbiguity.executionText, /\bundefined\b|\bnull\b|\bthrow\b|\bexception\b|valeur sentinelle|résultat vide|Task\s*\|\s*(?:undefined|null)/i);
  assert.doesNotMatch(absenceAmbiguity.executionText, /ambiguïté|clarification|information manquante|(?:non|pas) défini(?:e|es|s)?/i);

  const titleBoundaries = records[5];
  assert.equal(titleBoundaries.expectation, 'implementation');
  assert.match(titleBoundaries.caseText, /expectation: implementation/);
  assert.match(titleBoundaries.executionText, /createTask\(title\)/);
  assert.match(titleBoundaries.executionText, /`title` est normalisé avec `trim\(\)`/i);
  assert.match(titleBoundaries.executionText, /entre 1 et 80 caractères inclus/i);
  assert.match(titleBoundaries.executionText, /titre vide après normalisation est refusé/i);
  assert.match(titleBoundaries.executionText, /titre de 81 caractères est refusé/i);
  assert.match(titleBoundaries.executionText, /espaces internes, la casse et la ponctuation du titre sont conservés/i);
  assert.doesNotMatch(titleBoundaries.executionText, /format: codex-lab-benchmark|expectation: implementation/);
  const numericRules = [...titleBoundaries.executionText.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
  assert.deepEqual([...new Set(numericRules)].sort((a, b) => a - b), [1, 80, 81]);
  assert.doesNotMatch(titleBoundaries.executionText, /lowercase|uppercase|toLowerCase|toUpperCase|minuscules?|majuscules?/i);
  assert.doesNotMatch(titleBoundaries.executionText, /compact(?:er|age)|réduire les espaces internes|supprimer les espaces internes/i);
  assert.doesNotMatch(titleBoundaries.executionText, /whitelist|liste blanche|caractères? autorisés?|interdire certains caractères/i);

  const scopedSearch = records[6];
  assert.equal(scopedSearch.expectation, 'implementation');
  assert.match(scopedSearch.caseText, /expectation: implementation/);
  assert.match(scopedSearch.executionText, /findTaskById\(tasks, id\)/);
  assert.match(scopedSearch.executionText, /lorsqu’une tâche possède l’identifiant demandé, cette tâche est retournée/i);
  assert.match(scopedSearch.executionText, /recherche ne modifie ni la collection reçue ni les tâches qu’elle contient/i);
  assert.match(scopedSearch.executionText, /## Hors périmètre[\s\S]*comportement lorsqu’aucune tâche ne possède l’identifiant demandé/i);
  assert.doesNotMatch(scopedSearch.executionText, /format: codex-lab-benchmark|expectation: implementation/);
  assert.doesNotMatch(scopedSearch.executionText, /\bundefined\b|\bnull\b|\bexception\b|valeur sentinelle|type d['’]erreur/i);
  assert.doesNotMatch(scopedSearch.executionText, /(?:test|tests|testé)[^\n.]{0,100}(?:aucune tâche|identifiant absent|cas absent)/i);
  assert.doesNotMatch(scopedSearch.executionText, /clarification nécessaire|information manquante|décision à prendre|comportement non défini à résoudre/i);

  const publicApi = records[7];
  assert.equal(publicApi.expectation, 'implementation');
  assert.match(publicApi.executionText, /`src\/task\.ts` expose le type `Task`/);
  assert.match(publicApi.executionText, /createTask\(title\)/);
  assert.match(publicApi.executionText, /`src\/index\.ts` constitue le point d’entrée public/);
  assert.match(publicApi.executionText, /tests importent l’API testée uniquement depuis `\.\.\/src\/index\.js`/i);
  assert.match(publicApi.executionText, /modification de `src\/server\.ts`/i);
  assert.doesNotMatch(publicApi.executionText, /format: codex-lab-benchmark|expectation: implementation/);
  assert.doesNotMatch(publicApi.executionText, /service layer|repository pattern|factory|classe de stockage|injection de dépendances/i);

  const sharedTitleValidation = records[8];
  assert.equal(sharedTitleValidation.expectation, 'implementation');
  assert.match(sharedTitleValidation.executionText, /createTask\(title\)/);
  assert.match(sharedTitleValidation.executionText, /renameTask\(task, newTitle\)/);
  assert.match(sharedTitleValidation.executionText, /`renameTask\(task, newTitle\)` retourne une nouvelle `Task`/i);
  assert.match(sharedTitleValidation.executionText, /`Task` reçue n’est pas modifiée/i);
  assert.match(sharedTitleValidation.executionText, /tâche retournée conserve `id` et `completed`/i);
  assert.match(sharedTitleValidation.executionText, /définie une seule fois dans un module dédié/i);
  assert.match(sharedTitleValidation.executionText, /`createTask` et `renameTask` réutilisent cette même règle/i);
  assert.match(sharedTitleValidation.executionText, /`src\/index\.ts` expose l’API publique nécessaire/i);
  assert.doesNotMatch(sharedTitleValidation.executionText, /format: codex-lab-benchmark|expectation: implementation/);
  assert.doesNotMatch(sharedTitleValidation.executionText, /classe abstraite|dependency injection|^\s*-\s*repository\s*;|factory|hiérarchie de services/im);

  const completePriority = records[9];
  assert.equal(completePriority.expectation, 'implementation');
  assert.match(completePriority.executionText, /TaskPriority/);
  assert.match(completePriority.executionText, /`"low"`, `"medium"` ou `"high"`/);
  assert.match(completePriority.executionText, /valeur `"medium"` est utilisée/i);
  assert.match(completePriority.executionText, /`src\/task\.ts` contient les types publics `Task` et `TaskPriority`/);
  assert.match(completePriority.executionText, /`src\/task-service\.ts` contient `createTask`/);
  assert.match(completePriority.executionText, /`src\/index\.ts` constitue le point d’entrée public/);
  assert.match(completePriority.executionText, /tests importent uniquement depuis `\.\.\/src\/index\.js`/i);
  assert.doesNotMatch(completePriority.executionText, /format: codex-lab-benchmark|expectation: implementation/);
  const priorityValues = [...completePriority.executionText.matchAll(/`"(low|medium|high)"`/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(priorityValues)].sort(), ['high', 'low', 'medium']);
  for (const benchmark of [publicApi, sharedTitleValidation, completePriority]) {
    assert.doesNotMatch(benchmark.executionText, /(?:le|ce) benchmark|directement implémentable|sans clarification|ce qu['’]on cherche à tester/i);
  }
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

test('benchmarks implementation 006 à 010 masquent le frontmatter aux deux runs', async (t) => {
  const { root } = await fixture(t);
  const expectedInput = new Map([
    ['006-titre-bornes-1-80', /createTask\(title\)/],
    ['007-recherche-absence-hors-perimetre', /findTaskById\(tasks, id\)/],
    ['008-api-publique-index', /`src\/index\.ts` constitue le point d’entrée public/],
    ['009-validation-titre-partagee', /définie une seule fois dans un module dédié/i],
    ['010-priorite-contrat-complet-multifichier', /TaskPriority/],
  ]);
  const records = (await discoverBenchmarks(path.resolve('benchmarks'), [prompt]))
    .filter((item) => expectedInput.has(item.benchmarkId));
  assert.deepEqual(records.map((item) => item.benchmarkId), [...expectedInput.keys()]);
  for (const record of records) {
    const calls = []; const labels = [];
    const result = await runOneTest({ repoDir: root, resultsDir: path.join(root, 'results') }, record, {
      assertSafeImpl: async () => {}, restoreImpl: async () => {},
      runCodexImpl: async ({ input, outputDir }) => { calls.push(input); await mkdir(outputDir, { recursive: true }); return { success: true, exitStatus: 0, elapsedSeconds: 1, finalContent: 'fait', stdout: '', stderr: '' }; },
      saveValidateImpl: async ({ label }) => { labels.push(label); return { tests: 0, typescript: 0, diffCheck: 0, changedFiles: 1 }; },
      compareImpl: async (_a, _b, output) => writeFile(output, 'diff'),
    });
    assert.equal(result.status, 'completed'); assert.equal(calls.length, 2);
    assert.deepEqual(labels, ['BASELINE', 'AVEC PROMPT']);
    assert.equal(await readFile(result.paths.caseFile, 'utf8'), record.caseText);
    assert.match(calls[0], /^Exécute la demande/);
    assert.match(calls[1], /^Prompt versionné/);
    for (const input of calls) {
      assert.match(input, expectedInput.get(record.benchmarkId));
      assert.doesNotMatch(input, /format: codex-lab-benchmark|expectation: implementation/);
      if (/^00(?:8|9)|^010/.test(record.benchmarkId)) {
        assert.doesNotMatch(input, /(?:le|ce) benchmark|directement implémentable|sans clarification|ce qu['’]on cherche à tester|toutes les décisions métier nécessaires sont volontairement définies|il ne doit pas demander/i);
      }
    }
    assert.match(await readFile(result.paths.result, 'utf8'), /Type : benchmark fixe[\s\S]*Attente : implementation/);
    assert.notEqual(record.id, prompt.id);
  }
});

test('benchmarks clarification transmettent uniquement le body aux deux runs', async (t) => {
  const { root } = await fixture(t);
  const records = (await discoverBenchmarks(path.resolve('benchmarks'), [prompt]))
    .filter((item) => ['002-priorite-ambiguite', '004-renommer-contrat-mutation', '005-rechercher-contrat-absence'].includes(item.benchmarkId));
  assert.deepEqual(records.map((item) => item.benchmarkId), [
    '002-priorite-ambiguite', '004-renommer-contrat-mutation', '005-rechercher-contrat-absence',
  ]);
  for (const record of records) {
    const calls = [];
    const result = await runOneTest({ repoDir: root, resultsDir: path.join(root, 'results') }, record, {
      assertSafeImpl: async () => {}, restoreImpl: async () => {},
      runCodexImpl: async ({ input, outputDir }) => { calls.push(input); await mkdir(outputDir, { recursive: true }); return { success: true, exitStatus: 0, elapsedSeconds: 1, finalContent: 'Clarification demandée.', stdout: '', stderr: '' }; },
      saveValidateImpl: async () => ({ tests: 0, typescript: 0, diffCheck: 0, changedFiles: 0 }),
      compareImpl: async (_a, _b, output) => writeFile(output, '(Aucune différence)\n'),
    });
    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^Exécute la demande/);
    assert.match(calls[1], /^Prompt versionné/);
    for (const input of calls) {
      assert.doesNotMatch(input, /format: codex-lab-benchmark|expectation: clarification/);
    }
    if (record.benchmarkId === '004-renommer-contrat-mutation') {
      assert.match(calls[0], /renameTask\(task, newTitle\)/);
      assert.match(calls[1], /renameTask\(task, newTitle\)/);
    }
    if (record.benchmarkId === '005-rechercher-contrat-absence') {
      assert.match(calls[0], /findTaskById\(tasks, id\)/);
      assert.match(calls[1], /findTaskById\(tasks, id\)/);
    }
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
