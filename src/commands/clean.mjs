import { cleanResultsSafely } from '../core/result-storage.mjs';
import { confirmStrong } from '../ui/menu.mjs';
export async function cleanCommand(config, options = {}) {
  console.log(`Dossier ciblé : ${config.resultsDir}`);
  if (!options.yes && !(await confirmStrong('Tapez SUPPRIMER pour confirmer : '))) { console.log('Nettoyage annulé.'); return 0; }
  await cleanResultsSafely(config.resultsDir, config.resultsDir, [config.repoDir, config.playbookDir]); console.log('Résultats supprimés.'); return 0;
}
