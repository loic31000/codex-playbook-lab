# Codex Playbook Tests

Projet fictif utilisé pour tester les prompts du Codex Engineering Playbook.

## Fonctionnement

Le système comporte quatre éléments :

```text
run-test.ps1
= exécute un test complet

run-suite.ps1
= enchaîne tous les tests

tests-suite.json
= liste les cas et les prompts à tester

..\codex-playbook-test-runs\
= conserve les résultats
```

Chaque test est exécuté deux fois avec le même cas.

### Baseline

Codex reçoit uniquement le cas de test.

### Avec prompt

Le script lit automatiquement le fichier indiqué par `prompt` dans `tests-suite.json`, extrait la section :

```text
## Prompt prêt à copier
```

puis envoie ce prompt avec exactement le même cas de test.

Aucun prompt n'est copié manuellement dans Codex.

## Lancer toute la suite

Depuis la racine du dépôt :

```powershell
git pull --ff-only origin main
git status
.\run-suite.ps1
```

Le dépôt doit être propre avant le lancement.

La suite continue d'un test à l'autre même si un test échoue.

Les tests déjà terminés sont ignorés lors d'une nouvelle exécution.

Si un test a été interrompu après le baseline, `run-test.ps1` reprend au run avec prompt.

## Configurer les tests

Les tests à exécuter sont déclarés dans `tests-suite.json`.

Exemple :

```json
[
  {
    "id": "004",
    "case": "tests-cases/004-code-review.md",
    "prompt": "../codex-engineering-playbook-fr/11-Review-Convergence/01 - Code review.md",
    "enabled": true
  }
]
```

Champs :

- `id` : identifiant unique du test ;
- `case` : cas de test ;
- `prompt` : fichier du prompt à tester ;
- `enabled` : permet d'activer ou désactiver le test.

Utilise un nouvel `id` si le scénario ou le prompt testé change.

## Résultats

Les résultats sont enregistrés dans :

```text
..\codex-playbook-test-runs\
```

Pour un test `004` :

```text
004-baseline\
004-with-prompt\
004-comparison.diff
```

Après la suite complète :

```text
suite-summary.md
```

Ce fichier résume les tests terminés, ignorés et échoués.

## Lancer un seul test

```powershell
.\run-test.ps1 `
  -Id "004" `
  -Case "tests-cases/004-code-review.md" `
  -PromptPath "..\codex-engineering-playbook-fr\11-Review-Convergence\01 - Code review.md"
```

Guide détaillé : [GUIDE-TESTS-CODEX.md](GUIDE-TESTS-CODEX.md)

## Projet fictif

Petite API de gestion de tâches.

Fonctionnalités prévues :

- créer une tâche ;
- lister les tâches ;
- terminer une tâche.

Le projet reste volontairement simple afin de pouvoir rejouer les mêmes tests avec Codex.
