import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolvePortablePath(value, base = projectRoot, pathApi = path) {
  if (!value) return base;
  return pathApi.isAbsolute(value) ? pathApi.normalize(value) : pathApi.resolve(base, value);
}

export async function loadConfig(options = {}) {
  const repoDir = path.resolve(options.repoDir ?? process.env.CODEX_LAB_REPO_DIR ?? projectRoot);
  const configPath = resolvePortablePath(options.configPath ?? 'tests-suite.json', repoDir);
  let raw = {};
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Configuration invalide (${configPath}) : ${error.message}`);
  }

  const casesPerPrompt = Number(raw.cases_per_prompt ?? 1);
  if (!Number.isInteger(casesPerPrompt) || casesPerPrompt < 1) {
    throw new Error('cases_per_prompt doit être un entier positif.');
  }

  return {
    repoDir,
    configPath,
    playbookDir: resolvePortablePath(
      options.playbookDir ?? process.env.CODEX_LAB_PLAYBOOK_DIR ?? raw.playbook_path ?? '../codex-engineering-playbook-fr',
      repoDir,
    ),
    resultsDir: resolvePortablePath(
      options.resultsDir ?? process.env.CODEX_LAB_RESULTS_DIR ?? '../codex-playbook-test-runs',
      repoDir,
    ),
    casesPerPrompt,
  };
}

export async function ensureResultsWritable(resultsDir) {
  await mkdir(resultsDir, { recursive: true });
  await access(resultsDir, constants.R_OK | constants.W_OK);
}
