# Guide d’exploitation de Codex Playbook Lab

## 1. Vérifier avant de lancer

Depuis la racine du dépôt :

```powershell
git pull --ff-only
.\bin\codex-lab.ps1 check
```

Sous Linux :

```bash
./bin/codex-lab.sh check
```

Le diagnostic contrôle Git, Node, npm, Codex CLI, la configuration, l’accès aux résultats et le nombre de prompts. Un dépôt modifié produit un warning au diagnostic mais bloque volontairement tout run réel, car chaque run se termine par une restauration Git destructive des seules modifications produites par Codex.

## 2. Tester un prompt

Mode guidé :

```powershell
.\bin\codex-lab.ps1 test
```

Mode direct avec un ID affiché par `list` :

```powershell
.\bin\codex-lab.ps1 list
.\bin\codex-lab.ps1 test 09-01-implementer-story
```

On peut aussi fournir le chemin relatif du Markdown. Un simple préfixe ambigu est refusé.

## 3. Suite et reprise

```powershell
.\bin\codex-lab.ps1 suite
.\bin\codex-lab.ps1 resume
```

La reprise conserve les cas et runs valides. Elle reprend à la première étape manquante : cas, baseline, run avec prompt ou comparaison. Une panne d’infrastructure Codex ou une vraie limite détectée dans le diagnostic technique d’une commande en échec arrête la suite proprement.

Ne relancez pas la suite pour « tester » un quota. La détection est passive et ne scanne jamais aveuglément le cas ou la réponse métier.

## 4. Lire les résultats

```powershell
.\bin\codex-lab.ps1 results
```

Le dossier par défaut est `../codex-playbook-test-runs`. Il contient `suite-summary.md`, `generated-manifest.json` et un dossier humain par prompt/cas. Le fingerprint SHA-256 complet garantit qu’un changement du chemin, du bloc de prompt ou de l’index de cas est détecté.

Les preuves d’un run incluent : entrée Codex, sortie finale, stdout/stderr, log, exit status, état Git, diff, fichiers, tests, TypeScript, `git diff --check` et résumé.

## 5. Interruption

Ctrl+C arrête uniquement l’arbre Codex démarré par le run courant : `taskkill /PID … /T /F` sous Windows, groupe de processus dédié sous POSIX. Les logs déjà reçus sont conservés. Avant de relancer, utilisez `check` et vérifiez `git status`.

## 6. Nettoyer les résultats

Interactif :

```powershell
.\bin\codex-lab.ps1 clean
```

Le chemin exact est affiché et la confirmation `SUPPRIMER` est requise. Pour une automatisation explicite :

```powershell
.\bin\codex-lab.ps1 clean --yes
```

Cette commande ne cible jamais le dépôt de test, le playbook, les credentials ou la configuration Codex.

## 7. Docker

```bash
docker compose config
docker compose build
docker compose run --rm codex-lab check
```

Les chemins hôte peuvent être surchargés par `CODEX_LAB_PLAYBOOK_DIR` et `CODEX_LAB_RESULTS_DIR`. Sur Docker Desktop, partagez avec Docker les lecteurs contenant ces dossiers.

Pour les runs Codex, injectez `OPENAI_API_KEY` au runtime. L’entrypoint utilise `codex login --with-api-key`; aucune clé ne doit apparaître dans Dockerfile, Compose, Git ou une image. Un montage privé de `CODEX_HOME` est possible pour un login ChatGPT déjà établi, mais `auth.json` est un secret et ne doit jamais être copié dans l’image.

## 8. Dépannage rapide

- `Codex CLI introuvable` : installez `@openai/codex` puis vérifiez `codex --version`.
- `Run réel refusé` : inspectez `git status`; faites revoir et versionnez les fichiers voulus avant de relancer.
- `Prompt ambigu` : utilisez l’ID complet ou le chemin relatif donné par `list`.
- `unknown` : ce statut n’est accepté qu’avec une sortie finale non vide dans un ancien cas réellement indéterminé. Un code non nul reste toujours un échec.
- sandbox/EPERM : consultez `codex-stderr.txt` et les validations ; ce diagnostic reste distinct d’un défaut fonctionnel du repository.
