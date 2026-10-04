# Codex Playbook Lab

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/PowerShell-5.1-5391FE?style=for-the-badge&logo=powershell&logoColor=white" alt="PowerShell 5.1">
  <img src="https://img.shields.io/badge/Bash-Linux%20%2F%20macOS-4EAA25?style=for-the-badge&logo=gnubash&logoColor=white" alt="Bash">
  <img src="https://img.shields.io/badge/Docker-supported-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Codex%20CLI-0.160.0-000000?style=for-the-badge" alt="Codex CLI 0.160.0">
  <img src="https://img.shields.io/badge/Prompts-114-6f42c1?style=for-the-badge" alt="114 prompts">
</p>

Codex Playbook Lab compare, prompt par prompt, le comportement de Codex sans consigne spécialisée (baseline) puis avec les prompts du playbook français. Le moteur est commun à Windows, Linux/macOS et Docker : toute la logique métier vit dans `src/`, en Node.js standard.

## Projet associé

Ce dépôt est le laboratoire de test et de validation du projet [Codex Engineering Playbook FR](https://github.com/loic31000/codex-engineering-playbook-fr). Le playbook contient les prompts à évaluer ; Codex Playbook Lab les découvre, les exécute en comparaison baseline/avec prompt, puis conserve les résultats et validations.

## Architecture

- `src/cli.mjs` : commandes et menu communs ;
- `src/core/` : découverte, exécution Codex, reprise, résultats et validations ;
- `src/platform/` : arrêt ciblé des arbres de processus Windows/POSIX ;
- `bin/` : façades PowerShell 5.1 et Bash très fines ;
- `docker/` et `compose.yaml` : même moteur dans un conteneur ;
- scripts `.ps1` à la racine : compatibilité temporaire avec l’ancien usage.

Les résultats restent hors du dépôt, par défaut dans le sibling `../codex-playbook-test-runs`. Le playbook attendu par défaut est `../codex-engineering-playbook-fr`.

## Prérequis

- Node.js 20 ou plus récent ;
- npm ;
- Git ;
- Codex CLI installé et authentifié ;
- le dépôt du playbook placé à côté de celui-ci, sauf surcharge de configuration.

Le moteur n’ajoute aucune dépendance npm. Les dépendances déjà présentes servent uniquement à l’application TypeScript testée par le banc.

## Démarrage

Windows PowerShell 5.1 :

```powershell
.\bin\codex-lab.ps1
.\bin\codex-lab.ps1 check
```

Linux/macOS :

```bash
chmod +x bin/*.sh docker/entrypoint.sh
./bin/codex-lab.sh
./bin/codex-lab.sh check
```

Le menu commun propose la suite complète, un prompt, la reprise, le diagnostic, la lecture et le nettoyage des résultats.

## Commandes non interactives

```text
codex-lab check [--docker]
codex-lab list
codex-lab test <id-ou-chemin>
codex-lab test <id> --select-only
codex-lab suite [--prompt <id-ou-chemin>]
codex-lab benchmark [<id-benchmark-ou-id-prompt>]
codex-lab resume
codex-lab results
codex-lab clean --yes
```

Exemples :

```powershell
.\bin\codex-lab.ps1 test 09-01-implementer-story
.\bin\codex-lab.ps1 benchmark 09-01-implementer-story--benchmark-002-priorite-ambiguite
.\bin\codex-lab.ps1 benchmark 09-01-implementer-story
.\bin\run-suite.ps1 --prompt 09-01-implementer-story
```

Une sélection ambiguë est refusée. `test` sans argument affiche la liste humaine et ne demande jamais un hash.

## Configuration

`tests-suite.json` accepte `playbook_path`, `cases_per_prompt` et l’option `benchmarks_path`. Cette dernière désigne le dossier de benchmarks versionnés et reste facultative. Ces variables surchargent les chemins sans être obligatoires :

- `CODEX_LAB_PLAYBOOK_DIR`
- `CODEX_LAB_RESULTS_DIR`

Les chemins relatifs sont résolus depuis la racine du dépôt de test.

## Cas générés et benchmarks fixes

Les cas générés sont créés à partir du prompt et servent à l’exploration ; ils peuvent varier entre deux générations. La commande `test` conserve ce fonctionnement et `cases_per_prompt` reste supporté.

Les benchmarks fixes vivent dans `benchmarks/`. Ils sont versionnés, reproductibles et n’ajoutent aucun appel Codex pour générer le cas. Leur fingerprint dépend du fichier benchmark et du prompt testé. Une modification archive donc les anciens résultats selon les garde-fous existants, sans les supprimer.

Les trois premiers benchmarks ciblent `09-01-implementer-story` : ajout d’une tâche, ajout d’une priorité et liste des tâches. Le benchmark priorité attend une clarification sans modification, car les valeurs autorisées et la valeur par défaut constituent des décisions métier volontairement absentes. Ce résultat reste soumis à une appréciation humaine ; aucune notation automatique ni appel LLM juge n’est effectué.

## Flux et résultats

Chaque test suit strictement : CAS → BASELINE → VALIDATION → AVEC PROMPT → VALIDATION → COMPARAISON. Un run valide est réutilisé lors d’une reprise. Les anciens dossiers `auto-*` sont migrés sans écrasement ; un fingerprint différent archive l’ancien dossier sous `_archive/`.

Les runs Codex utilisent explicitement le sandbox `workspace-write`. Si Codex signale malgré cela que le workspace est en lecture seule et qu’aucune modification n’a été produite, le run est invalidé et sera rejoué lors d’une reprise. Sous Windows natif, Docker/Linux constitue la solution de repli si le sandbox refuse encore l’écriture.

Chaque dossier lisible contient notamment `fingerprint.txt`, `case.md`, `generation.log`, `result.md`, `diff.patch`, `base/` et `prompt/`. Les sous-dossiers de run conservent l’entrée, la sortie finale, stdout, stderr, le log combiné, le statut structuré, le diff, les fichiers modifiés et les sorties de validation.

`diff.patch` représente exclusivement la transformation **BASELINE → AVEC PROMPT**. Ses headers utilisent des chemins relatifs portables comme `a/src/task.ts` et `b/src/task.ts` ; il ne représente pas nécessairement une transformation de `HEAD` vers un résultat.

Un run moderne n’est réutilisable que si Codex a réussi, si `git diff --check` passe et si les tests et TypeScript sont soit réussis, soit explicitement classés comme limitation d’environnement. `case.md`, les deux runs valides, `diff.patch` et `result.md` sont tous requis pour considérer un test terminé. Les anciens runs PowerShell dépourvus de `codex-status.json` et `summary.json` conservent un fallback documenté ; un run Node incomplet ne bénéficie pas de cette tolérance.

Après chaque run, le moteur exécute :

```text
npm test -- --run
npx tsc --noEmit
git --no-pager diff --check
git --no-pager reset --hard HEAD
git --no-pager clean -fd
```

## Sécurité Git

Un run réel est refusé si le dépôt contient une modification ou un fichier non suivi. Cela protège à la fois le travail utilisateur et le moteur contre `reset --hard` / `clean -fd`. Il faut donc faire revoir puis versionner l’infrastructure avant son premier run réel. `check` se contente d’un warning et n’appelle aucun modèle.

`clean` ne cible que le dossier de résultats configuré. En interactif il exige le mot `SUPPRIMER`; en non interactif il exige `--yes`.

## Docker

```bash
docker compose run --rm codex-lab check
docker compose run --rm codex-lab test 09-01-implementer-story
```

Compose monte le dépôt Git, le playbook en lecture seule et les résultats persistants. La version de Codex CLI est fixée à `0.160.0` via `CODEX_VERSION`, un argument de build facile à modifier.

Pour une exécution automatisée, fournissez la clé uniquement au runtime :

```bash
export OPENAI_API_KEY='...'
docker compose run --rm codex-lab check
```

L’entrypoint transmet la clé à la commande officielle `codex login --with-api-key`; elle n’est jamais copiée dans l’image ni dans le dépôt. Pour un login ChatGPT existant, créez un override Compose privé qui monte votre `CODEX_HOME` dans le conteneur, sans jamais committer `auth.json`. `check` n’effectue aucun appel de modèle et ne nécessite pas d’authentification.

## Compatibilité

`codex-lab.ps1`, `run-suite.ps1`, `run-test.ps1` et `save-run.ps1` restent à la racine comme redirections fines. Les nouvelles commandes recommandées sont celles de `bin/`.

Sous Windows, le moteur résout d’abord un exécutable Codex natif. À défaut, il exécute précisément le shim `codex.cmd` via `cmd.exe`, avec des arguments cités, sans activer `shell: true` globalement.

## Tests du moteur

```bash
npm run test:lab
```

Ces tests utilisent des fixtures et des processus factices ; ils ne consomment aucun quota Codex.
