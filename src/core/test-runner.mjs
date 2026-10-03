import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatElapsed, isInfrastructureFailure, isRateLimitFailure, runCodex } from './codex-process.mjs';
import { getResumeState, initializeTestStorage, migrateLegacyGeneratedCase, readRunStatus } from './result-storage.mjs';
import { assertSafeRealRun, compareRuns, restoreRepository, saveAndValidateRun } from './validation.mjs';
import { fail, ok, step, warn } from '../ui/console.mjs';

export class CodexRunError extends Error {
  constructor(message, result) { super(message); this.result = result; this.rateLimit = isRateLimitFailure(result); this.infrastructure = isInfrastructureFailure(result); }
}

function caseGenerationInput(test) {
  return `Tu génères un cas de test fictif pour évaluer un prompt Codex.\n\nRepository de test disponible : le repository courant.\nPrompt à évaluer : ${test.relativePath ?? test.id}\n\nPROMPT À ÉVALUER\n----------------\n${test.promptBlock}\n----------------\n\nCrée UN cas de test réaliste, autonome et suffisamment discriminant pour comparer :\n1. Codex sans ce prompt ;\n2. Codex avec ce prompt.\n\nRègles :\n- n'évalue pas le prompt ;\n- ne donne pas la solution du cas ;\n- ne mentionne pas qu'il s'agit d'un baseline ou d'un test A/B ;\n- n'inclus pas le texte du prompt dans le cas ;\n- utilise le repository courant quand le prompt concerne du code ;\n- sous Windows PowerShell 5.1, lis les fichiers texte explicitement en UTF-8 afin de préserver les accents ;\n- n’interprète pas une erreur EPERM, Access denied ou une restriction du sandbox comme un défaut du repository ;\n- n’exécute des tests, builds ou validations que s’ils sont réellement utiles à la tâche évaluée ;\n- si le prompt porte sur une review, un diagnostic, des logs, une architecture, une spécification ou de la documentation, fournis dans le cas tout le matériau concret nécessaire ;\n- introduis une ambiguïté seulement si elle est pertinente pour ce prompt ;\n- évite les dépendances externes et les services réseau ;\n- le cas doit pouvoir être exécuté sans intervention humaine ;\n- reste compact.\n\nRetourne uniquement le Markdown du cas de test.\n`;
}

function baselineInput(caseText) {
  return `Exécute la demande décrite dans le cas de test ci-dessous.\nUtilise le repository comme contexte et modifie le code uniquement si le cas le demande.\nSous Windows PowerShell 5.1, si tu lis un fichier texte, lis-le explicitement en UTF-8 afin de préserver les accents.\nN’exécute des tests, builds ou outils de validation que s’ils sont pertinents pour la tâche.\nSi une commande échoue uniquement avec EPERM, Access denied ou une restriction du sandbox, traite cela comme une limitation d’environnement et non comme un défaut du repository.\n\n${caseText}\n`;
}

function promptedInput(caseText, promptBlock) {
  return `${promptBlock}\n\nContrainte d'environnement : sous Windows PowerShell 5.1, si tu lis un fichier texte, lis-le explicitement en UTF-8 afin de préserver les accents.\nN’exécute des tests, builds ou outils de validation que s’ils sont pertinents pour la tâche.\nSi une commande échoue uniquement avec EPERM, Access denied ou une restriction du sandbox, traite cela comme une limitation d’environnement et non comme un défaut du repository.\n\nCas de test à traiter :\n\n${caseText}\n`;
}

async function executeRun({ config, runDir, label, input, runCodexImpl, saveValidateImpl }) {
  step(label, 'Exécution Codex...');
  const result = await runCodexImpl({ input, outputDir: runDir, cwd: config.repoDir, activity: `${label} — Codex travaille toujours...` });
  if (result.success) ok(`${label} terminé en ${formatElapsed(result.elapsedSeconds)}`);
  else warn(`${label} en échec ; sauvegarde des preuves et restauration en cours`);
  step('VALIDATION');
  const validation = await saveValidateImpl({ repoDir: config.repoDir, runDir, label });
  showValidation('Tests', validation.tests, validation.classifications?.tests);
  showValidation('TypeScript', validation.typescript, validation.classifications?.typescript);
  if (validation.diffCheck === 0) ok('git diff --check OK'); else fail(`git diff --check KO — code ${validation.diffCheck}`);
  ok('Dépôt restauré');
  if (!result.success) throw new CodexRunError(`Codex a échoué pendant ${label} (code ${result.exitStatus}).`, result);
  const acceptable = (code, classification) => classification === 'environment-limitation'
    || (code === 0 && (classification === 'passed' || classification === undefined));
  if (!acceptable(validation.tests, validation.classifications?.tests)
    || !acceptable(validation.typescript, validation.classifications?.typescript)
    || validation.diffCheck !== 0) {
    throw new Error(`Validation ${label} en échec ; le run ne sera pas réutilisé.`);
  }
}

export function showValidation(label, code, classification) {
  if (classification === 'environment-limitation') warn(`${label} non concluant — limitation d’environnement reconnue`);
  else if ((classification === 'passed' && code === 0) || (classification === undefined && code === 0)) ok(`${label} OK`);
  else fail(`${label} KO — code ${code}`);
}

export async function runOneTest(config, test, options = {}) {
  const runCodexImpl = options.runCodexImpl ?? runCodex;
  const assertSafeImpl = options.assertSafeImpl ?? assertSafeRealRun;
  const saveValidateImpl = options.saveValidateImpl ?? saveAndValidateRun;
  const compareImpl = options.compareImpl ?? compareRuns;
  const restoreImpl = options.restoreImpl ?? restoreRepository;
  const paths = await initializeTestStorage(config.resultsDir, test);
  await migrateLegacyGeneratedCase(config.resultsDir, test, paths);
  let state = await getResumeState(paths);
  if (state.complete) { ok(`${test.id} déjà terminé`); return { status: 'skipped', paths }; }
  await assertSafeImpl(config.repoDir);

  if (!state.caseReady) {
    step('CAS');
    const temporary = path.join(paths.root, '.generation');
    const generated = await runCodexImpl({ input: caseGenerationInput(test), outputDir: temporary, cwd: config.repoDir, activity: 'Codex génère le cas...' });
    await cp(path.join(temporary, 'codex-log.txt'), paths.generationLog);
    await restoreImpl(config.repoDir);
    if (!generated.success || !generated.finalContent?.trim()) throw new CodexRunError('Génération du cas impossible.', generated);
    await writeFile(paths.caseFile, `${generated.finalContent.trim()}\n`, 'utf8');
    await rm(temporary, { recursive: true, force: true });
    ok(`Cas généré en ${formatElapsed(generated.elapsedSeconds)}`);
  }
  const caseText = await readFile(paths.caseFile, 'utf8');

  const baseStatus = await readRunStatus(paths.base);
  if (!baseStatus.valid) {
    if (baseStatus.reason !== 'missing') await rm(paths.base, { recursive: true, force: true });
    await executeRun({ config, runDir: paths.base, label: 'BASELINE', input: baselineInput(caseText), runCodexImpl, saveValidateImpl });
  } else warn('Baseline valide réutilisé');

  const promptStatus = await readRunStatus(paths.prompt);
  if (!promptStatus.valid) {
    if (promptStatus.reason !== 'missing') await rm(paths.prompt, { recursive: true, force: true });
    await executeRun({ config, runDir: paths.prompt, label: 'AVEC PROMPT', input: promptedInput(caseText, test.promptBlock), runCodexImpl, saveValidateImpl });
  } else warn('Run avec prompt valide réutilisé');

  step('COMPARAISON');
  await compareImpl(paths.base, paths.prompt, paths.comparison, config.repoDir);
  const finalState = await getResumeState(paths);
  const resultText = `# ${test.displayName}\n\n- Baseline : valide\n- Avec prompt : valide\n- Comparaison : ${finalState.comparison ? 'créée' : 'absente'}\n`;
  await writeFile(paths.result, resultText, 'utf8');
  ok('Comparaison créée'); ok('Test terminé');
  return { status: 'completed', paths };
}
