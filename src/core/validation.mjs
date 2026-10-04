import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
    const tracked = await git(['diff', '--name-only', '-z'], { cwd: repoDir });
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoDir });
    const files = [...new Set(`${tracked.stdout}${untracked.stdout}`.split('\0').filter(Boolean))];
    await writeFile(path.join(runDir, 'files-list.txt'), `${files.join('\n')}\n`, 'utf8');
    const filesRoot = path.join(runDir, 'files'); await mkdir(filesRoot, { recursive: true });
    for (const file of files) {
      const source = path.join(repoDir, file); const destination = path.join(filesRoot, ...file.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      try { await cp(source, destination, { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const tests = await capture('npm', ['test', '--', '--run'], repoDir, path.join(runDir, 'tests.txt'));
    const typescript = await capture('npx', ['tsc', '--noEmit'], repoDir, path.join(runDir, 'typescript.txt'));
    results = { tests: tests.code ?? 1, typescript: typescript.code ?? 1,
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

export async function compareRuns(baseDir, promptDir, outputFile, repoDir) {
  const result = await git(['diff', '--no-index', '--text', path.join(baseDir, 'files'), path.join(promptDir, 'files')], { cwd: repoDir });
  if (![0, 1].includes(result.code)) throw new Error(`Comparaison impossible (${result.code ?? 'unknown'}).`);
  await writeFile(outputFile, result.stdout || '(Aucune différence)\n', 'utf8');
}
