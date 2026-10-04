import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertComparisonExitCode, compareRuns } from '../../src/core/validation.mjs';
import { run } from '../../src/core/process.mjs';

async function diffFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-portable-diff-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'base', 'files'); const prompt = path.join(root, 'prompt', 'files');
  await mkdir(path.join(base, 'src'), { recursive: true }); await mkdir(path.join(prompt, 'src'), { recursive: true });
  await writeFile(path.join(base, 'src', 'modified file.txt'), 'avant\n'); await writeFile(path.join(prompt, 'src', 'modified file.txt'), 'après\n');
  await writeFile(path.join(base, 'src', 'removed.txt'), 'supprimé\n'); await writeFile(path.join(prompt, 'src', 'added.txt'), 'ajouté\n');
  return { root, base: path.dirname(base), prompt: path.dirname(prompt), baseFiles: base, promptFiles: prompt, patch: path.join(root, 'diff.patch') };
}

test('diff portable couvre modification, ajout, suppression, espaces et application baseline vers prompt', async (t) => {
  const fixture = await diffFixture(t); await compareRuns(fixture.base, fixture.prompt, fixture.patch, fixture.root);
  const patchText = await readFile(fixture.patch, 'utf8');
  assert.match(patchText, /a\/src\/modified file\.txt/); assert.match(patchText, /b\/src\/modified file\.txt/);
  assert.match(patchText, /a\/src\/removed\.txt/); assert.match(patchText, /b\/src\/added\.txt/);
  assert.doesNotMatch(patchText, /[A-Za-z]:\\|codex-lab-portable-diff|base\/files|prompt\/files/);
  const target = path.join(fixture.root, 'target'); await mkdir(target); await cp(fixture.baseFiles, target, { recursive: true });
  const check = await run('git', ['apply', '--check', fixture.patch], { cwd: target }); assert.equal(check.code, 0, check.stderr);
  const apply = await run('git', ['apply', fixture.patch], { cwd: target }); assert.equal(apply.code, 0, apply.stderr);
  assert.equal((await readFile(path.join(target, 'src', 'modified file.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'après\n');
  assert.equal((await readFile(path.join(target, 'src', 'added.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'ajouté\n');
  await assert.rejects(readFile(path.join(target, 'src', 'removed.txt'), 'utf8'));
});

test('diff sans changement conserve le marqueur historique', async (t) => {
  const fixture = await diffFixture(t); await rm(fixture.promptFiles, { recursive: true }); await cp(fixture.baseFiles, fixture.promptFiles, { recursive: true });
  await compareRuns(fixture.base, fixture.prompt, fixture.patch, fixture.root);
  assert.equal(await readFile(fixture.patch, 'utf8'), '(Aucune différence)\n');
});

test('codes Git 0 et 1 sont acceptés, les autres refusés', () => {
  assert.doesNotThrow(() => assertComparisonExitCode(0)); assert.doesNotThrow(() => assertComparisonExitCode(1));
  assert.throws(() => assertComparisonExitCode(2), /Comparaison impossible/);
  assert.throws(() => assertComparisonExitCode(null), /unknown/);
});
