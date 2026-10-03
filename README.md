# Codex Playbook Tests

Projet fictif utilisé pour tester les prompts du Codex Engineering Playbook.

## Principe

Chaque cas de test est exécuté automatiquement deux fois par `run-test.ps1`.

### 1. Baseline sans prompt

Codex reçoit uniquement le cas de test.

Le prompt du playbook n'est pas utilisé.

### 2. Run avec prompt

Le script lit automatiquement le fichier indiqué avec `-PromptPath`.

Il extrait uniquement la section :

```text
## Prompt prêt à copier
```

Puis il envoie à Codex :

```text
prompt extrait du playbook
+
même cas de test
```

Tu ne copies donc jamais le prompt manuellement dans Codex.

Exemple :

```powershell
.\run-test.ps1 `
  -Id "004" `
  -Case "tests-cases/004-code-review.md" `
  -PromptPath "..\codex-engineering-playbook-fr\11-Review-Convergence\01 - Code review.md"
```

Le script sauvegarde les deux runs, remet le dépôt à son état initial entre les exécutions et génère automatiquement un fichier de comparaison.

Guide complet : [GUIDE-TESTS-CODEX.md](GUIDE-TESTS-CODEX.md)

## Projet

Petite API de gestion de tâches.

Fonctionnalités prévues :

- créer une tâche ;
- lister les tâches ;
- terminer une tâche.

Le projet doit rester volontairement simple afin de pouvoir rejouer les mêmes tests avec Codex.
