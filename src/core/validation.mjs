import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, run } from './process.mjs';

async function capture(command, args, cwd, outputFile) {
  const result = await run(command, args, { cwd });
  await writeFile(outputFile, `${result.stdout}${result.stderr}`, 'utf8');
  return result;
}

export function validationClassification(result) {
  if (result.code === 0) return 'passed';
  return /(EPERM|EACCES|access (?:is )?denied|permission denied|operation not permitted)/i.test(`${result.stdout}\n${result.stderr}`)
    ? 'environment-limitation' : 'failed';
}

export async function repositoryStatus(repoDir) {
  return git(['status', '--porcelain', '--untracked-files=all'], { cwd: repoDir });
}

export async function assertSafeRealRun(repoDir) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd: repoDir });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Error('Le dossier de test n’est pas un repository Git.');
  const status = await repositoryStatus(repoDir);
  if (status.code !== 0) throw new Error('Impossible de lire l’état Git.');
  if (status.stdout.trim()) throw new Error('Run réel refusé : le repository doit être entièrement propre et le moteur doit être versionné avant reset/clean.');
}

export async function restoreRepository(repoDir) {
  const reset = await git(['reset', '--hard', 'HEAD'], { cwd: repoDir });
  if (reset.code !== 0) throw new Error('git reset --hard HEAD a échoué.');
  const clean = await git(['clean', '-fd'], { cwd: repoDir });
  if (clean.code !== 0) throw new Error('git clean -fd a échoué.');
  const final = await repositoryStatus(repoDir);
  if (final.code !== 0 || final.stdout.trim()) throw new Error('Le repository n’est pas propre après restauration.');
}

function parseNameStatus(raw) {
  const tokens = raw.split('\0').filter((value, index, all) => value || index < all.length - 1);
  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const code = tokens[index]; const file = tokens[index + 1];
    if (!code || !file) throw new Error('Sortie Git name-status invalide.');
    changes.push({ path: file, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified' });
  }
  return changes;
}

function safeSnapshotPath(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Chemin d’état invalide : ${relativePath}`);
  }
  return target;
}

export async function captureRunState(repoDir, runDir, baseCommit) {
  const tracked = await git(['diff', '--name-status', '-z', '--no-renames', baseCommit], { cwd: repoDir });
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoDir });
  if (tracked.code !== 0 || untracked.code !== 0) throw new Error('Impossible de construire le manifest d’état Git.');
  const byPath = new Map(parseNameStatus(tracked.stdout).map((entry) => [entry.path, entry]));
  for (const file of untracked.stdout.split('\0').filter(Boolean)) byPath.set(file, { path: file, status: 'added' });
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const filesRoot = path.join(runDir, 'files'); await rm(filesRoot, { recursive: true, force: true }); await mkdir(filesRoot, { recursive: true });
  for (const entry of files) {
    if (entry.status === 'deleted') continue;
    const source = safeSnapshotPath(repoDir, entry.path); const destination = safeSnapshotPath(filesRoot, entry.path);
    await mkdir(path.dirname(destination), { recursive: true }); await cp(source, destination, { recursive: true });
  }
  const manifest = { version: 1, baseCommit, files };
  await Promise.all([
    writeFile(path.join(runDir, 'state-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(path.join(runDir, 'files-list.txt'), `${files.map((entry) => entry.path).join('\n')}\n`, 'utf8'),
  ]);
  return manifest;
}

export async function saveAndValidateRun({ repoDir, runDir, label, restoreImpl = restoreRepository }) {
  let results = { tests: 1, typescript: 1, diffCheck: 1 };
  let workError = null;
  let restorationError = null;
  try {
    await mkdir(runDir, { recursive: true });
    const branch = await git(['branch', '--show-current'], { cwd: repoDir });
    const commit = await git(['rev-parse', 'HEAD'], { cwd: repoDir });
    await writeFile(path.join(runDir, 'metadata.json'), `${JSON.stringify({ label, timestamp: new Date().toISOString(), branch: branch.stdout.trim(), commit: commit.stdout.trim() }, null, 2)}\n`, 'utf8');
    const status = await git(['status', '--short'], { cwd: repoDir });
    const diff = await git(['diff', '--binary'], { cwd: repoDir });
    const diffStat = await git(['diff', '--stat'], { cwd: repoDir });
    await Promise.all([
      writeFile(path.join(runDir, 'git-status.txt'), status.stdout, 'utf8'),
      writeFile(path.join(runDir, 'diff.patch'), diff.stdout, 'utf8'),
      writeFile(path.join(runDir, 'diff-stat.txt'), diffStat.stdout, 'utf8'),
    ]);
    const state = await captureRunState(repoDir, runDir, commit.stdout.trim());
    const tests = await capture('npm', ['test', '--', '--run'], repoDir, path.join(runDir, 'tests.txt'));
    const typescript = await capture('npx', ['tsc', '--noEmit'], repoDir, path.join(runDir, 'typescript.txt'));
    results = { tests: tests.code ?? 1, typescript: typescript.code ?? 1, changedFiles: state.files.length,
      classifications: { tests: validationClassification(tests), typescript: validationClassification(typescript) } };
    const diffCheck = await git(['diff', '--check'], { cwd: repoDir });
    results.diffCheck = diffCheck.code ?? 1;
    await writeFile(path.join(runDir, 'diff-check.txt'), `${diffCheck.stdout}${diffCheck.stderr}`, 'utf8');
    await writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  } catch (error) {
    workError = error;
  } finally {
    try { await restoreImpl(repoDir); } catch (error) { restorationError = error; }
  }
  if (workError && restorationError) {
    throw new AggregateError([workError, restorationError],
      `La sauvegarde/validation et la restauration ont échoué : ${workError.message}; ${restorationError.message}`);
  }
  if (restorationError) throw restorationError;
  if (workError) throw workError;
  return results;
}

export function assertComparisonExitCode(code) {
  if (![0, 1].includes(code)) throw new Error(`Comparaison impossible (${code ?? 'unknown'}).`);
}

async function copySnapshot(source, destination) {
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await cp(path.join(source, entry.name), path.join(destination, entry.name), { recursive: true });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readStateManifest(runDir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(runDir, 'state-manifest.json'), 'utf8'));
    if (manifest.version !== 1 || typeof manifest.baseCommit !== 'string' || !Array.isArray(manifest.files)) throw new Error('format invalide');
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !['added', 'modified', 'deleted'].includes(entry.status)) throw new Error('entrée invalide');
      safeSnapshotPath(runDir, entry.path);
    }
    return manifest;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Manifest d’état invalide (${runDir}) : ${error.message}`);
  }
}

async function materializeState(runDir, manifest, repoDir, paths, destination) {
  const changes = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const relativePath of paths) {
    const entry = changes.get(relativePath);
    if (entry?.status === 'deleted') continue;
    const source = entry ? safeSnapshotPath(path.join(runDir, 'files'), relativePath) : safeSnapshotPath(repoDir, relativePath);
    const target = safeSnapshotPath(destination, relativePath);
    try { await mkdir(path.dirname(target), { recursive: true }); await cp(source, target, { recursive: true }); }
    catch (error) {
      if (error.code === 'ENOENT' && !entry) continue;
      throw new Error(`État de run incomplet pour ${relativePath} : ${error.message}`);
    }
  }
}

async function checkedGit(args, cwd, env) {
  const result = await git(args, { cwd, env });
  if (result.code !== 0) throw new Error(`Préparation de la comparaison impossible (${result.code ?? 'unknown'}) : ${result.stderr.trim()}`);
  return result;
}

async function diffSnapshots(left, right, outputFile, env) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-diff-'));
  try {
    const gitDirectory = path.join(worktree, '.git'); await mkdir(gitDirectory);
    const emptyGlobalConfig = path.join(gitDirectory, 'codex-empty-global'); await writeFile(emptyGlobalConfig, '', 'utf8');
    const isolatedEnv = { ...env, GIT_CONFIG_GLOBAL: emptyGlobalConfig, GIT_CONFIG_NOSYSTEM: '1' };
    await checkedGit(['init', '--quiet'], worktree, isolatedEnv);
    const hooks = path.join(gitDirectory, 'codex-empty-hooks'); await mkdir(hooks);
    await checkedGit(['config', '--local', 'core.autocrlf', 'false'], worktree, isolatedEnv);
    await checkedGit(['config', '--local', 'commit.gpgSign', 'false'], worktree, isolatedEnv);
    await checkedGit(['config', '--local', 'core.hooksPath', hooks], worktree, isolatedEnv);
    await copySnapshot(left, worktree);
    await checkedGit(['add', '-A'], worktree, isolatedEnv);
    await checkedGit(['-c', 'commit.gpgSign=false', '-c', 'user.name=Codex Lab', '-c', 'user.email=lab@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'baseline'], worktree, isolatedEnv);
    await checkedGit(['rm', '-r', '-f', '--quiet', '--ignore-unmatch', '.'], worktree, isolatedEnv);
    await copySnapshot(right, worktree);
    await checkedGit(['add', '-A'], worktree, isolatedEnv);
    const result = await git(['diff', '--cached', '--exit-code', '--binary', '--text', '--find-renames',
      '--src-prefix=a/', '--dst-prefix=b/'], { cwd: worktree, env: isolatedEnv });
    assertComparisonExitCode(result.code);
    await writeFile(outputFile, result.stdout || '(Aucune différence)\n', 'utf8');
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}

export async function compareRuns(baseDir, promptDir, outputFile, repoDir, options = {}) {
  const [baseState, promptState] = await Promise.all([readStateManifest(baseDir), readStateManifest(promptDir)]);
  if (!baseState || !promptState) throw new Error('Comparaison impossible : manifest d\u2019\u00e9tat manquant pour un run.');
  if (baseState.baseCommit !== promptState.baseCommit) throw new Error('Comparaison impossible : les runs ne partagent pas le même commit de base.');
  const current = await git(['rev-parse', 'HEAD'], { cwd: repoDir, env: options.env });
  if (current.code !== 0 || current.stdout.trim() !== baseState.baseCommit) {
    throw new Error('Comparaison impossible : le repository n’est plus sur le commit de base des runs.');
  }
  const paths = [...new Set([...baseState.files, ...promptState.files].map((entry) => entry.path))].sort((a, b) => a.localeCompare(b, 'en'));
  const states = await mkdtemp(path.join(os.tmpdir(), 'codex-lab-states-'));
  try {
    const left = path.join(states, 'baseline'); const right = path.join(states, 'prompt'); await mkdir(left); await mkdir(right);
    await materializeState(baseDir, baseState, repoDir, paths, left);
    await materializeState(promptDir, promptState, repoDir, paths, right);
    return await diffSnapshots(left, right, outputFile, options.env);
  } finally { await rm(states, { recursive: true, force: true }); }
}
