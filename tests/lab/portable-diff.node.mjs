import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertComparisonExitCode, captureRunState, compareRuns } from '../../src/core/validation.mjs';
import { run } from '../../src/core/process.mjs';

const initialFiles = new Map([
  ['baseline supprime.txt', 'commun baseline supprime\n'],
  ['prompt supprime.txt', 'commun prompt supprime\n'],
  ['les deux suppriment.txt', 'commun deux suppressions\n'],
  ['baseline modifie.txt', 'commun baseline modifie\n'],
  ['prompt modifie.txt', 'commun prompt modifie\n'],
  ['dossier espace/élève.txt', 'commun unicode\n'],
]);

async function gitOk(cwd, args) {
  const result = await run('git', args, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function writeRelative(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function restore(repo) {
  await gitOk(repo, ['reset', '--hard', 'HEAD']);
  await gitOk(repo, ['clean', '-fd']);
}

async function stateFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-state-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); const base = path.join(root, 'runs', 'base'); const prompt = path.join(root, 'runs', 'prompt');
  await mkdir(repo); await mkdir(base, { recursive: true }); await mkdir(prompt, { recursive: true });
  for (const [file, content] of initialFiles) await writeRelative(repo, file, content);
  await gitOk(repo, ['init', '--quiet']); await gitOk(repo, ['config', 'core.autocrlf', 'false']); await gitOk(repo, ['add', '-A']);
  await gitOk(repo, ['-c', 'commit.gpgSign=false', '-c', 'user.name=Codex Lab', '-c', 'user.email=lab@example.invalid', 'commit', '--quiet', '-m', 'base']);
  const baseCommit = await gitOk(repo, ['rev-parse', 'HEAD']);

  await rm(path.join(repo, 'baseline supprime.txt')); await rm(path.join(repo, 'les deux suppriment.txt'));
  await writeRelative(repo, 'baseline modifie.txt', 'baseline modifié\n');
  await writeRelative(repo, 'dossier espace/élève.txt', 'baseline unicode\n');
  await writeRelative(repo, 'ajout baseline.txt', 'ajout baseline\n');
  await writeRelative(repo, 'ajout identique.txt', 'ajout partagé\n');
  const baseState = await captureRunState(repo, base, baseCommit); await restore(repo);

  await rm(path.join(repo, 'prompt supprime.txt')); await rm(path.join(repo, 'les deux suppriment.txt'));
  await writeRelative(repo, 'prompt modifie.txt', 'prompt modifié\n');
  await writeRelative(repo, 'dossier espace/élève.txt', 'prompt unicode\n');
  await writeRelative(repo, 'ajout prompt.txt', 'ajout prompt\n');
  await writeRelative(repo, 'ajout identique.txt', 'ajout partagé\n');
  const promptState = await captureRunState(repo, prompt, baseCommit); await restore(repo);
  return { root, repo, base, prompt, baseCommit, baseState, promptState, patch: path.join(root, 'diff.patch') };
}

function stateMap(manifest) {
  return new Map(manifest.files.map((entry) => [entry.path, entry.status]));
}

const lf = (text) => text.replace(/\r\n/g, '\n');

async function materializeBaseline(target) {
  await mkdir(target);
  for (const [file, content] of initialFiles) await writeRelative(target, file, content);
  await rm(path.join(target, 'baseline supprime.txt')); await rm(path.join(target, 'les deux suppriment.txt'));
  await writeRelative(target, 'baseline modifie.txt', 'baseline modifié\n');
  await writeRelative(target, 'dossier espace/élève.txt', 'baseline unicode\n');
  await writeRelative(target, 'ajout baseline.txt', 'ajout baseline\n');
  await writeRelative(target, 'ajout identique.txt', 'ajout partagé\n');
}

test('manifest NUL-safe conserve added, modified et deleted avec espaces et Unicode', async (t) => {
  const fixture = await stateFixture(t); const base = stateMap(fixture.baseState); const prompt = stateMap(fixture.promptState);
  assert.equal(base.get('baseline supprime.txt'), 'deleted'); assert.equal(prompt.has('baseline supprime.txt'), false);
  assert.equal(base.has('prompt supprime.txt'), false); assert.equal(prompt.get('prompt supprime.txt'), 'deleted');
  assert.equal(base.get('les deux suppriment.txt'), 'deleted'); assert.equal(prompt.get('les deux suppriment.txt'), 'deleted');
  assert.equal(base.get('baseline modifie.txt'), 'modified'); assert.equal(prompt.has('baseline modifie.txt'), false);
  assert.equal(base.has('prompt modifie.txt'), false); assert.equal(prompt.get('prompt modifie.txt'), 'modified');
  assert.equal(base.get('ajout baseline.txt'), 'added'); assert.equal(prompt.get('ajout prompt.txt'), 'added');
  assert.equal(base.get('ajout identique.txt'), 'added'); assert.equal(prompt.get('ajout identique.txt'), 'added');
  assert.equal(base.get('dossier espace/élève.txt'), 'modified'); assert.equal(prompt.get('dossier espace/élève.txt'), 'modified');
  assert.equal(fixture.baseState.baseCommit, fixture.baseCommit); assert.equal(fixture.promptState.baseCommit, fixture.baseCommit);
  await assert.rejects(readFile(path.join(fixture.base, 'files', 'baseline supprime.txt'), 'utf8'));
});

test('comparaison reconstruit les états logiques et produit un patch portable applicable', async (t) => {
  const fixture = await stateFixture(t); await compareRuns(fixture.base, fixture.prompt, fixture.patch, fixture.repo);
  const patchText = await readFile(fixture.patch, 'utf8');
  for (const file of ['baseline supprime.txt', 'prompt supprime.txt', 'baseline modifie.txt', 'prompt modifie.txt', 'ajout baseline.txt', 'ajout prompt.txt']) {
    assert.match(patchText, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(patchText, /^diff --git a\/.* b\/.*$/m);
  assert.doesNotMatch(patchText, /les deux suppriment|ajout identique/);
  assert.doesNotMatch(patchText, /[A-Za-z]:\\|codex-lab-state-diff|runs\/base|runs\/prompt/);

  const target = path.join(fixture.root, 'target'); await materializeBaseline(target);
  const check = await run('git', ['apply', '--check', fixture.patch], { cwd: target }); assert.equal(check.code, 0, check.stderr);
  const apply = await run('git', ['apply', fixture.patch], { cwd: target }); assert.equal(apply.code, 0, apply.stderr);
  assert.equal(lf(await readFile(path.join(target, 'baseline supprime.txt'), 'utf8')), initialFiles.get('baseline supprime.txt'));
  await assert.rejects(readFile(path.join(target, 'prompt supprime.txt'), 'utf8'));
  await assert.rejects(readFile(path.join(target, 'les deux suppriment.txt'), 'utf8'));
  assert.equal(lf(await readFile(path.join(target, 'baseline modifie.txt'), 'utf8')), initialFiles.get('baseline modifie.txt'));
  assert.equal(lf(await readFile(path.join(target, 'prompt modifie.txt'), 'utf8')), 'prompt modifié\n');
  await assert.rejects(readFile(path.join(target, 'ajout baseline.txt'), 'utf8'));
  assert.equal(lf(await readFile(path.join(target, 'ajout prompt.txt'), 'utf8')), 'ajout prompt\n');
  assert.equal(lf(await readFile(path.join(target, 'ajout identique.txt'), 'utf8')), 'ajout partagé\n');
  assert.equal(lf(await readFile(path.join(target, 'dossier espace', 'élève.txt'), 'utf8')), 'prompt unicode\n');
});

test('comparaison refuse explicitement des commits de base différents', async (t) => {
  const fixture = await stateFixture(t);
  const manifestPath = path.join(fixture.prompt, 'state-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.baseCommit = '0'.repeat(40);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await assert.rejects(compareRuns(fixture.base, fixture.prompt, fixture.patch, fixture.repo), /même commit de base/);
});

test('dépôt temporaire ignore commit.gpgSign global sans modifier la configuration', async (t) => {
  const fixture = await stateFixture(t); const globalConfig = path.join(fixture.root, 'global.gitconfig');
  const config = '[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = programme-gpg-introuvable\n';
  await writeFile(globalConfig, config, 'utf8');
  await compareRuns(fixture.base, fixture.prompt, fixture.patch, fixture.repo, { env: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(await readFile(globalConfig, 'utf8'), config); assert.match(await readFile(fixture.patch, 'utf8'), /^diff --git /m);
});

test('diff sans changement conserve le marqueur historique', async (t) => {
  const fixture = await stateFixture(t); await rm(fixture.prompt, { recursive: true }); await cp(fixture.base, fixture.prompt, { recursive: true });
  await compareRuns(fixture.base, fixture.prompt, fixture.patch, fixture.repo);
  assert.equal(await readFile(fixture.patch, 'utf8'), '(Aucune différence)\n');
});

test('codes Git 0 et 1 sont acceptés, les autres refusés', () => {
  assert.doesNotThrow(() => assertComparisonExitCode(0)); assert.doesNotThrow(() => assertComparisonExitCode(1));
  assert.throws(() => assertComparisonExitCode(2), /Comparaison impossible/);
  assert.throws(() => assertComparisonExitCode(null), /unknown/);
});
