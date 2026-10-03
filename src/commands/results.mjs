import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listResultDirectories } from '../core/result-storage.mjs';
export async function resultsCommand(config) {
  const dirs = await listResultDirectories(config.resultsDir);
  console.log(`Résultats : ${config.resultsDir}`); console.log(`${dirs.length} dossier(s) de test.`);
  try { console.log(await readFile(path.join(config.resultsDir, 'suite-summary.md'), 'utf8')); } catch {}
  return 0;
}
