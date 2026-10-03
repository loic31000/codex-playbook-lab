import { access } from 'node:fs/promises';
import path from 'node:path';
import { discoverPrompts } from '../core/prompt-discovery.mjs';
import { ensureResultsWritable } from '../core/config.mjs';
import { git, run } from '../core/process.mjs';
import { fail, ok, warn } from '../ui/console.mjs';
import { runCodexVersion } from '../core/codex-process.mjs';

export async function checkCommand(config, options = {}) {
  let failures = 0;
  const repo = await git(['rev-parse', '--is-inside-work-tree'], { cwd: config.repoDir });
  if (repo.code === 0 && repo.stdout.trim() === 'true') ok('Repository Git'); else { fail('Repository Git introuvable'); failures += 1; }
  const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: config.repoDir });
  if (status.code === 0 && !status.stdout.trim()) ok('Repository propre'); else warn('Repository modifié (warning pour check, blocage pour un run réel)');
  ok(`Node ${process.version}`);
  const npm = await run('npm', ['--version'], { cwd: config.repoDir });
  if (npm.code === 0) ok(`npm ${npm.stdout.trim()}`); else { fail('npm introuvable'); failures += 1; }
  const codex = await runCodexVersion({ cwd: config.repoDir });
  if (codex.code === 0) ok(`Codex CLI ${codex.stdout.trim()} (${codex.resolution.kind})`); else { fail('Codex CLI introuvable'); failures += 1; }
  try { const prompts = await discoverPrompts(config.playbookDir, config.casesPerPrompt); ok(`Playbook : ${prompts.length} prompts`); }
  catch (error) { fail(`Playbook inaccessible : ${error.message}`); failures += 1; }
  try { await ensureResultsWritable(config.resultsDir); ok(`Résultats accessibles : ${config.resultsDir}`); }
  catch (error) { fail(`Résultats inaccessibles : ${error.message}`); failures += 1; }
  const required = ['bin/codex-lab.ps1', 'bin/codex-lab.sh', 'src/cli.mjs'];
  for (const file of required) { try { await access(path.join(config.repoDir, file)); } catch { fail(`Façade essentielle absente : ${file}`); failures += 1; } }
  const untrackedEssentials = await git(['ls-files', '--error-unmatch', '--', ...required], { cwd: config.repoDir });
  if (untrackedEssentials.code === 0) ok('Fichiers essentiels versionnés'); else warn('Fichiers essentiels non encore versionnés : les runs réels restent bloqués');
  if (options.docker) {
    const docker = await run('docker', ['--version'], { cwd: config.repoDir });
    if (docker.code === 0) ok(docker.stdout.trim()); else { fail('Docker indisponible'); failures += 1; }
  }
  return failures === 0 ? 0 : 1;
}
