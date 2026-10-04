import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprintPrompt, slugify } from '../../src/core/fingerprints.mjs';
import { extractPromptBlock, hasPromptFrontmatter, selectPrompt } from '../../src/core/prompt-discovery.mjs';
import { activeCodexCount, evaluateExit, formatElapsed, isRateLimitFailure, resolveCodexCommand, runCodex, runCodexVersion } from '../../src/core/codex-process.mjs';
import { cleanResultsSafely, getResumeState, initializeTestStorage, migrateLegacyGeneratedCase, readRunStatus, safeResultDirectory } from '../../src/core/result-storage.mjs';
import { loadConfig, resolvePortablePath } from '../../src/core/config.mjs';
import { runOneTest, showValidation } from '../../src/core/test-runner.mjs';
import { run } from '../../src/core/process.mjs';
import { assertSafeRealRun, saveAndValidateRun, validationClassification } from '../../src/core/validation.mjs';
import { runSuite } from '../../src/core/suite-runner.mjs';

async function writeSavedRun(directory, { exit = '0', modern = true, tests = 'passed', typescript = 'passed', diffCheck = 0, fallback = false } = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'codex-log.txt'), 'log');
  await writeFile(path.join(directory, 'codex-final.txt'), 'final');
  await writeFile(path.join(directory, 'codex-exit-code.txt'), `${exit}\n`);
  if (modern) {
    const success = exit === '0' || (exit === 'unknown' && fallback);
    await writeFile(path.join(directory, 'codex-status.json'), JSON.stringify({ code: /^\d+$/.test(exit) ? Number(exit) : 'unknown', success, fallback }));
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify({
      tests: tests === 'passed' ? 0 : 1, typescript: typescript === 'passed' ? 0 : 1, diffCheck,
      classifications: { tests, typescript },
    }));
  }
}

test('slug lisible sans accents et fingerprint SHA-256 stable', () => {
  assert.equal(slugify('Inconnues, hypothèses & décisions'), 'inconnues-hypotheses-decis');
  const a = fingerprintPrompt('01/a.md', 'bonjour', 1);
  assert.match(a, /^[a-f0-9]{64}$/); assert.equal(a, fingerprintPrompt('01/a.md', 'bonjour', 1));
  assert.notEqual(a, fingerprintPrompt('01/a.md', 'bonjour', 2));
});

test('chrono monotone et minutes tronquées', () => {
  assert.deepEqual([20, 25, 30, 35, 55, 60, 65].map(formatElapsed), ['00:20', '00:25', '00:30', '00:35', '00:55', '01:00', '01:05']);
});

test('frontmatter et section de prompt exacts', () => {
  const valid = '---\nformat: prompt\n---\n\n## Prompt prêt à copier\n```text\nFais ceci.\n```\n';
  assert.equal(hasPromptFrontmatter(valid), true); assert.equal(extractPromptBlock(valid), 'Fais ceci.');
  assert.equal(extractPromptBlock(valid.replace('format: prompt', 'format: guide')), null);
  assert.equal(extractPromptBlock(valid.replace('Prompt prêt à copier', 'Prompt')), null);
});

test('résolution portable Windows et POSIX', () => {
  assert.equal(resolvePortablePath('..\\playbook', 'C:\\work\\lab', path.win32), 'C:\\work\\playbook');
  assert.equal(resolvePortablePath('../playbook', '/work/lab', path.posix), '/work/playbook');
});

test('statuts exit code et fallback unknown', () => {
  assert.deepEqual(evaluateExit({ code: 0, signal: null, finalContent: 'ok' }).success, true);
  assert.deepEqual(evaluateExit({ code: 1, signal: null, finalContent: 'ok' }).success, false);
  assert.deepEqual(evaluateExit({ code: null, signal: null, finalContent: 'ok', allowUnknownFallback: true }).success, true);
  assert.deepEqual(evaluateExit({ code: null, signal: null, finalContent: '', allowUnknownFallback: true }).success, false);
  assert.deepEqual(evaluateExit({ code: null, signal: 'SIGTERM', finalContent: 'ok', allowUnknownFallback: true }).success, false);
});

test('rate limit uniquement sur échec technique stderr', () => {
  assert.equal(isRateLimitFailure({ success: true, stderr: 'HTTP 429' }), false);
  assert.equal(isRateLimitFailure({ success: false, stdout: 'HTTP 429', stderr: '' }), false);
  assert.equal(isRateLimitFailure({ success: false, stderr: 'status code 429 too many requests' }), true);
});

test('reprise complète exige aussi result.md', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-resume-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { caseFile: path.join(root, 'case.md'), base: path.join(root, 'base'), prompt: path.join(root, 'prompt'), comparison: path.join(root, 'diff.patch'), result: path.join(root, 'result.md') };
  await writeFile(paths.caseFile, 'case');
  for (const dir of [paths.base, paths.prompt]) await writeSavedRun(dir, { modern: false });
  await writeFile(paths.comparison, 'diff');
  assert.equal((await getResumeState(paths)).complete, false);
  await writeFile(paths.result, 'résultat');
  assert.equal((await getResumeState(paths)).complete, true);
  await writeFile(path.join(paths.prompt, 'codex-exit-code.txt'), '1\n');
  assert.equal((await getResumeState(paths)).complete, false);
});

test('migration legacy idempotente et non destructive', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-migrate-')); t.after(() => rm(root, { recursive: true, force: true }));
  const testRecord = { id: '01-01-exemple', legacyId: 'auto-abcdef123456', fingerprint: 'f'.repeat(64) };
  await mkdir(path.join(root, testRecord.legacyId)); await writeFile(path.join(root, testRecord.legacyId, 'case.md'), 'ancien');
  const paths = await initializeTestStorage(root, testRecord);
  assert.equal(await readFile(paths.caseFile, 'utf8'), 'ancien');
  const again = await initializeTestStorage(root, testRecord); assert.equal(again.root, paths.root);
});

test('un dossier lisible non vide sans fingerprint est archivé', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-no-fingerprint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const record = { id: '01-01-inconnu', legacyId: 'auto-333333333333', fingerprint: 'd'.repeat(64) };
  await mkdir(path.join(root, record.id)); await writeFile(path.join(root, record.id, 'case.md'), 'origine inconnue');
  const paths = await initializeTestStorage(root, record);
  await assert.rejects(readFile(paths.caseFile, 'utf8'));
  const archives = await import('node:fs/promises').then((fs) => fs.readdir(path.join(root, '_archive')));
  assert.equal(archives.length, 1); assert.match(archives[0], /sans-fingerprint/);
  assert.equal(await readFile(path.join(root, '_archive', archives[0], 'case.md'), 'utf8'), 'origine inconnue');
  assert.equal((await readFile(paths.fingerprint, 'utf8')).trim(), record.fingerprint);
});

test('migration generated-cases copie sans écraser', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-generated-')); t.after(() => rm(root, { recursive: true, force: true }));
  const record = { id: '01-01-x', legacyId: 'auto-111111111111', fingerprint: 'a'.repeat(64) };
  await mkdir(path.join(root, 'generated-cases')); await writeFile(path.join(root, 'generated-cases', `${record.legacyId}.md`), 'legacy');
  const paths = await initializeTestStorage(root, record);
  assert.equal(await migrateLegacyGeneratedCase(root, record, paths), true);
  assert.equal(await migrateLegacyGeneratedCase(root, record, paths), false);
});

test('migration de la disposition legacy auto-* complète', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-legacy-layout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const record = { id: '01-02-layout', legacyId: 'auto-222222222222', fingerprint: 'c'.repeat(64) };
  await mkdir(path.join(root, `${record.legacyId}-baseline`));
  await mkdir(path.join(root, `${record.legacyId}-with-prompt`));
  await writeFile(path.join(root, `${record.legacyId}-comparison.diff`), 'diff');
  const paths = await initializeTestStorage(root, record);
  assert.equal((await getResumeState({ ...paths, caseFile: path.join(root, 'absent-case') })).comparison, true);
  assert.equal((await readFile(paths.comparison, 'utf8')), 'diff');
});

test('nettoyage refuse une cible différente de la destination configurée', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-clean-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(cleanResultsSafely(root, path.join(root, 'results')));
  await assert.rejects(cleanResultsSafely(root, root, [path.join(root, 'repo')]));
});

test('chemins de résultats refusent toute sortie du dossier configuré', () => {
  const root = path.resolve('results');
  assert.equal(safeResultDirectory(root, '..safe'), path.join(root, '..safe'));
  for (const name of ['', '.', '..', '../outside', '..\\outside', 'nested/run']) {
    assert.throws(() => safeResultDirectory(root, name), /invalide|hors/);
  }
});

test('nettoyage refuse aussi une cible située dans un dossier protégé', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-clean-nested-')); t.after(() => rm(root, { recursive: true, force: true }));
  const results = path.join(root, 'repo', 'results'); await mkdir(results, { recursive: true });
  await assert.rejects(cleanResultsSafely(results, results, [path.join(root, 'repo')]), /chevauche/);
});

test('le mot sandbox seul ne masque pas un véritable échec', () => {
  assert.equal(validationClassification({ code: 1, stdout: 'sandbox behavior failed', stderr: '' }), 'failed');
  assert.equal(validationClassification({ code: 1, stdout: '', stderr: 'operation not permitted (EPERM)' }), 'environment-limitation');
});

test('configuration et sélection mono-prompt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'suite.json'), JSON.stringify({ playbook_path: '../pb', cases_per_prompt: 2 }));
  const config = await loadConfig({ repoDir: root, configPath: 'suite.json', resultsDir: '../out' });
  assert.equal(config.casesPerPrompt, 2); assert.equal(config.playbookDir, path.resolve(root, '../pb'));
  const prompts = [{ id: '01-01-alpha', relativePath: '01/a.md', fullPath: path.join(root, 'a.md') }, { id: '01-02-beta', relativePath: '01/b.md', fullPath: path.join(root, 'b.md') }];
  assert.equal(selectPrompt(prompts, '01-02-beta').relativePath, '01/b.md');
  assert.throws(() => selectPrompt(prompts, '01'));
});

test('un moteur non suivi bloque le reset/clean avant tout run réel', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-git-safety-')); t.after(() => rm(root, { recursive: true, force: true }));
  await run('git', ['init'], { cwd: root }); await writeFile(path.join(root, 'tracked.txt'), 'ok');
  await run('git', ['add', 'tracked.txt'], { cwd: root });
  await run('git', ['-c', 'user.name=Codex Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-m', 'fixture'], { cwd: root });
  const engine = path.join(root, 'engine-untracked.mjs'); await writeFile(engine, 'export {};');
  await assert.rejects(assertSafeRealRun(root), /entièrement propre/);
  assert.equal(await readFile(engine, 'utf8'), 'export {};');
});

test('validité moderne combine Codex et toutes les validations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-status-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['passed', {}, true],
    ['tests failed', { tests: 'failed' }, false],
    ['TypeScript failed', { typescript: 'failed' }, false],
    ['diff failed', { diffCheck: 1 }, false],
    ['environment limitation', { tests: 'environment-limitation' }, true],
    ['exit non nul', { exit: '1' }, false],
  ];
  for (const [name, options, expected] of cases) {
    const directory = path.join(root, name); await writeSavedRun(directory, options);
    assert.equal((await readRunStatus(directory)).valid, expected, name);
  }
});

test('résultat moderne incomplet et fallback unknown sont stricts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-modern-status-')); t.after(() => rm(root, { recursive: true, force: true }));
  const missingSummary = path.join(root, 'missing-summary'); await writeSavedRun(missingSummary);
  await rm(path.join(missingSummary, 'summary.json')); assert.equal((await readRunStatus(missingSummary)).valid, false);
  const allowed = path.join(root, 'allowed'); await writeSavedRun(allowed, { exit: 'unknown', fallback: true });
  assert.equal((await readRunStatus(allowed)).valid, true);
  const notAllowed = path.join(root, 'not-allowed'); await writeSavedRun(notAllowed, { exit: 'unknown', fallback: false });
  assert.equal((await readRunStatus(notAllowed)).valid, false);
  const empty = path.join(root, 'empty'); await writeSavedRun(empty, { exit: 'unknown', fallback: true });
  await writeFile(path.join(empty, 'codex-exit-code.txt'), ''); assert.equal((await readRunStatus(empty)).valid, false);
});

test('ancien résultat sans summary conserve une compatibilité explicite', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-legacy-status-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeSavedRun(root, { modern: false, exit: 'unknown' });
  const status = await readRunStatus(root); assert.equal(status.valid, true); assert.equal(status.legacy, true); assert.equal(status.fallback, true);
});

test('SIGINT interrompt un run sans polluer le suivant', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-child-')); t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'grandchild.pid');
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const promise = runCodex({ input: 'x', outputDir: root, command: process.execPath, args: ['-e', script], heartbeatMs: 60000 });
  let grandchildPid;
  for (let i = 0; i < 20; i += 1) { try { grandchildPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  const previousExitCode = process.exitCode;
  assert.equal(activeCodexCount(), 1); process.emit('SIGINT'); const first = await promise;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(first.interrupted, true); assert.equal(first.interruptionSignal, 'SIGINT');
  assert.equal(activeCodexCount(), 0); assert.ok(grandchildPid);
  assert.throws(() => process.kill(grandchildPid, 0));
  assert.equal(process.exitCode, 130); process.exitCode = previousExitCode;
  const secondDir = path.join(root, 'second');
  const second = await runCodex({ input: '', outputDir: secondDir, command: process.execPath, args: ['-e', ''], heartbeatMs: 60000 });
  assert.equal(second.interrupted, false); assert.equal(second.success, true);
});

test('résolution Windows préfère le natif puis utilise le shim cmd', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-resolve-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: root, ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  await writeFile(path.join(root, 'codex.cmd'), '@echo off');
  assert.equal(resolveCodexCommand('codex', { platform: 'win32', env }).kind, 'cmd-shim');
  await writeFile(path.join(root, 'codex.exe'), '');
  assert.equal(resolveCodexCommand('codex', { platform: 'win32', env }).kind, 'direct');
  const actual = await runCodexVersion(); assert.equal(actual.code, 0); assert.match(actual.stdout, /codex/i);
});

test('shim codex.cmd est exécutable sans shell global sous Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex lab shim-')); t.after(() => rm(root, { recursive: true, force: true }));
  const shim = path.join(root, 'codex.cmd'); await writeFile(shim, '@echo off\r\necho codex-cli fixture\r\n');
  const result = await runCodexVersion({ command: shim });
  assert.equal(result.code, 0); assert.match(result.stdout, /codex-cli fixture/); assert.equal(result.resolution.kind, 'cmd-shim');
});

test('UI ne présente jamais une validation KO comme réussie', () => {
  const logs = []; const errors = []; const oldLog = console.log; const oldError = console.error;
  console.log = (value) => logs.push(value); console.error = (value) => errors.push(value);
  try {
    showValidation('Tests', 0, 'passed'); showValidation('TypeScript', 1, 'environment-limitation'); showValidation('Tests', 1, 'failed');
  } finally { console.log = oldLog; console.error = oldError; }
  assert.match(logs.join('\n'), /✓ Tests OK/); assert.match(logs.join('\n'), /limitation d’environnement/);
  assert.match(errors.join('\n'), /✗ Tests KO/);
});

test('double échec conserve validation et restauration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-aggregate-')); t.after(() => rm(root, { recursive: true, force: true }));
  const occupied = path.join(root, 'occupied'); await writeFile(occupied, 'fichier');
  await assert.rejects(saveAndValidateRun({ repoDir: root, runDir: occupied, label: 'x',
    restoreImpl: async () => { throw new Error('restauration simulée'); } }), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.message, /validation.*restauration/); return true;
  });
});

test('une exception pendant la génération restaure quand même le dépôt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-generation-restore-')); t.after(() => rm(root, { recursive: true, force: true }));
  let restorations = 0;
  const testRecord = { id: '01-01-generation', legacyId: 'auto-generation', fingerprint: 'c'.repeat(64), displayName: 'Génération', promptBlock: 'Consigne' };
  await assert.rejects(runOneTest({ repoDir: root, resultsDir: path.join(root, 'results') }, testRecord, {
    assertSafeImpl: async () => {},
    runCodexImpl: async () => { throw new Error('lancement impossible'); },
    restoreImpl: async () => { restorations += 1; },
  }), /lancement impossible/);
  assert.equal(restorations, 1);
});

test('une exception Codex pendant un run passe encore par validation/restauration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-run-restore-')); t.after(() => rm(root, { recursive: true, force: true }));
  const resultsDir = path.join(root, 'results');
  const testRecord = { id: '01-01-run', legacyId: 'auto-run', fingerprint: 'd'.repeat(64), displayName: 'Run', promptBlock: 'Consigne' };
  const paths = await initializeTestStorage(resultsDir, testRecord); await writeFile(paths.caseFile, '# Cas\n');
  let validations = 0;
  await assert.rejects(runOneTest({ repoDir: root, resultsDir }, testRecord, {
    assertSafeImpl: async () => {},
    runCodexImpl: async () => { throw new Error('processus interrompu'); },
    saveValidateImpl: async () => { validations += 1; return { tests: 0, typescript: 0, diffCheck: 0 }; },
  }), /processus interrompu/);
  assert.equal(validations, 1);
});

test('suite échouée retourne non-zéro après sauvegarde du résumé', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-suite-exit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = { id: '01-01-x', displayName: 'X', relativePath: 'x.md', caseIndex: 1, fingerprint: 'f', legacyId: 'auto-f' };
  const result = await runSuite({ resultsDir: root }, { prepared: { prompts: [prompt], selected: [prompt] },
    runOneTestImpl: async () => { throw new Error('échec simulé'); } });
  assert.equal(result.exitCode, 1); assert.match(await readFile(path.join(root, 'suite-summary.md'), 'utf8'), /failed/);
});

test('suite propage interruption et panne infrastructure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-suite-special-')); t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = { id: '01-01-x', displayName: 'X', relativePath: 'x.md', caseIndex: 1, fingerprint: 'f', legacyId: 'auto-f' };
  const prepared = { prompts: [prompt], selected: [prompt] };
  const interrupted = await runSuite({ resultsDir: path.join(root, 'interrupt') }, { prepared, runOneTestImpl: async () => {
    const error = new Error('interrompu'); error.result = { interrupted: true, interruptionSignal: 'SIGTERM' }; throw error;
  } });
  assert.equal(interrupted.exitCode, 143);
  const infrastructure = await runSuite({ resultsDir: path.join(root, 'infra') }, { prepared, runOneTestImpl: async () => {
    const error = new Error('infrastructure'); error.infrastructure = true; throw error;
  } });
  assert.equal(infrastructure.exitCode, 2);
});

test('un baseline réussi atteint AVEC PROMPT puis COMPARAISON', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-flow-')); t.after(() => rm(root, { recursive: true, force: true }));
  const labels = []; let call = 0;
  const fakeCodex = async ({ outputDir }) => {
    call += 1; await mkdir(outputDir, { recursive: true });
    const finalContent = call === 1 ? '# Cas' : 'travail fini';
    await writeFile(path.join(outputDir, 'codex-final.txt'), finalContent);
    await writeFile(path.join(outputDir, 'codex-log.txt'), 'log');
    await writeFile(path.join(outputDir, 'codex-exit-code.txt'), '0\n');
    return { success: true, exitStatus: 0, finalContent, elapsedSeconds: 1, stderr: '' };
  };
  const saveValidate = async ({ runDir, label }) => {
    labels.push(label); await mkdir(path.join(runDir, 'files'), { recursive: true });
    return { tests: 0, typescript: 0, diffCheck: 0 };
  };
  const compare = async (_base, _prompt, output) => { labels.push('COMPARAISON'); await writeFile(output, 'diff'); };
  const testRecord = { id: '01-01-flow', legacyId: 'auto-123456789abc', fingerprint: 'b'.repeat(64), displayName: '01-01 Flow', promptBlock: 'Consigne' };
  const result = await runOneTest({ repoDir: root, resultsDir: path.join(root, 'results') }, testRecord, { runCodexImpl: fakeCodex, assertSafeImpl: async () => {}, restoreImpl: async () => {}, saveValidateImpl: saveValidate, compareImpl: compare });
  assert.equal(result.status, 'completed'); assert.deepEqual(labels, ['BASELINE', 'AVEC PROMPT', 'COMPARAISON']);
});
