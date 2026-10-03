import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { banner } from './console.mjs';

async function ask(question) { const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question(question); } finally { rl.close(); } }
export async function confirmStrong(question) { return (await ask(question)).trim() === 'SUPPRIMER'; }
export async function choosePrompt(prompts) {
  prompts.forEach((p, i) => console.log(`${String(i + 1).padStart(3)}. ${p.displayName} — ${p.relativePath}`));
  const value = (await ask('Numéro, ID ou chemin (vide pour annuler) : ')).trim();
  if (!value) return null;
  if (/^\d+$/.test(value) && prompts[Number(value) - 1]) return prompts[Number(value) - 1];
  const { selectPrompt } = await import('../core/prompt-discovery.mjs'); return selectPrompt(prompts, value);
}
export async function mainMenu() {
  banner();
  console.log('[1] Suite complète\n[2] Tester un prompt\n[3] Reprendre une suite\n[4] Vérifier l’environnement\n[5] Voir les résultats\n[6] Nettoyer les résultats\n[Q] Quitter');
  return (await ask('\nChoix : ')).trim().toLowerCase();
}
