# Guide simple - Tester les prompts avec Codex

## Objectif

Le système automatise la comparaison entre :

- Codex sans prompt du playbook ;
- Codex avec le prompt du playbook.

L'usage normal consiste maintenant à lancer toute la suite avec une seule commande.

```powershell
.\run-suite.ps1
```

Tu ne copies jamais les prompts manuellement dans Codex.

---

## 1. Les fichiers importants

```text
run-test.ps1
= moteur d'un test

run-suite.ps1
= lance tous les tests l'un après l'autre

tests-suite.json
= liste des tests à lancer

tests-cases\
= scénarios de test

..\codex-playbook-test-runs\
= résultats générés
```

---

## 2. Avant de lancer la suite

Ouvre PowerShell dans le dépôt `codex-playbook-tests`.

Récupère les dernières modifications :

```powershell
git pull --ff-only origin main
```

Vérifie l'état Git :

```powershell
git status
```

Le dépôt doit être propre :

```text
nothing to commit, working tree clean
```

---

## 3. Déclarer les tests

Le fichier `tests-suite.json` contient la liste des tests.

Exemple :

```json
[
  {
    "id": "004",
    "case": "tests-cases/004-code-review.md",
    "prompt": "../codex-engineering-playbook-fr/11-Review-Convergence/01 - Code review.md",
    "enabled": true
  },
  {
    "id": "005",
    "case": "tests-cases/005-debug.md",
    "prompt": "../codex-engineering-playbook-fr/10-Debug/01 - Debug.md",
    "enabled": true
  }
]
```

Chaque entrée contient :

- `id` : identifiant unique ;
- `case` : chemin du cas de test ;
- `prompt` : chemin du prompt du playbook ;
- `enabled` : `true` pour exécuter le test, `false` pour l'ignorer.

Le cas de test et `tests-suite.json` doivent être commités avant le lancement.

Si tu modifies réellement un scénario ou le prompt associé, utilise un nouvel identifiant de test afin de ne pas réutiliser d'anciens résultats.

---

## 4. Ajouter un nouveau cas

Crée le fichier dans `tests-cases`.

Exemple :

```text
tests-cases/004-code-review.md
```

Ajoute ensuite ce test dans `tests-suite.json`.

Puis commit :

```powershell
git add tests-cases tests-suite.json
git commit -m "test: add scenario 004"
git push origin main
```

---

## 5. Lancer toute la suite

Une seule commande :

```powershell
.\run-suite.ps1
```

Le script lit `tests-suite.json` puis exécute les tests dans l'ordre.

Pour chaque test :

```text
cas de test
    |
    v
baseline sans prompt
    |
    v
sauvegarde
    |
    v
reset du dépôt
    |
    v
lecture du fichier prompt
    |
    v
extraction de "Prompt prêt à copier"
    |
    v
même cas + prompt
    |
    v
run avec prompt
    |
    v
sauvegarde
    |
    v
reset du dépôt
    |
    v
comparison.diff
```

Puis le script passe automatiquement au test suivant.

---

## 6. Reprendre une suite interrompue

Relance simplement :

```powershell
.\run-suite.ps1
```

Comportement normal :

- un test entièrement terminé est sauté ;
- si seul le baseline valide existe, le test reprend avec le prompt ;
- si les deux runs valides existent mais pas la comparaison, seule la comparaison est générée ;
- une erreur normale est enregistrée et la suite passe au test suivant.

Les résultats valides existants ne sont pas écrasés.

---

## 7. Quota ou rate limit Codex

Si Codex renvoie une limite d'utilisation ou de débit, la suite ne continue pas à produire des faux échecs.

`run-suite.ps1` détecte notamment les messages liés à :

```text
429
rate limit
too many requests
usage limit
insufficient_quota
credit_balance_exhausted
organization_usage_limit_exceeded
organization_spend_limit_exceeded
project_spend_limit_exceeded
slow_down
```

Lorsqu'une limite est détectée :

```text
test en cours
    |
    v
limite Codex détectée
    |
    v
suppression du run incomplet uniquement
    |
    v
conservation des runs valides
    |
    v
suite-summary.md = ARRÊT LIMITE
    |
    v
arrêt propre de la suite
```

Aucune boucle de retry automatique n'est lancée pendant que la limite est active.

Quand la limite est réinitialisée, relance simplement :

```powershell
.\run-suite.ps1
```

La suite saute les tests déjà terminés et reprend le test interrompu au bon endroit.

Exemple :

```text
001 = terminé
002 = terminé
003 = rate limit pendant with-prompt
004 = pas encore lancé

Relance suivante :

001 = sauté
002 = sauté
003 = baseline conservé, with-prompt relancé
004 = lancé ensuite
```

---

## 8. Où trouver les résultats

Les résultats sont placés dans le dossier frère :

```text
..\codex-playbook-test-runs\
```

Exemple pour le test `004` :

```text
004-baseline\
004-with-prompt\
004-comparison.diff
004-suite.log
```

Chaque run contient notamment :

```text
codex-final.txt
codex-input.txt
codex-exit-code.txt
diff.patch
files-list.txt
tests.txt
typescript.txt
diff-check.txt
summary.txt
files\
```

À la fin de la suite ou après un arrêt de limite, un résumé global est créé :

```text
..\codex-playbook-test-runs\suite-summary.md
```

Il peut contenir les statuts :

```text
OK
DÉJÀ TERMINÉ
IGNORÉ
ÉCHEC
ARRÊT LIMITE
```

---

## 9. Lancer un seul test

Pour tester uniquement un scénario :

```powershell
.\run-test.ps1 `
  -Id "004" `
  -Case "tests-cases/004-code-review.md" `
  -PromptPath "..\codex-engineering-playbook-fr\11-Review-Convergence\01 - Code review.md"
```

`run-suite.ps1` utilise ce même moteur automatiquement.

---

## 10. Routine normale

```text
1. Créer les cas utiles
2. Les ajouter à tests-suite.json
3. Commit + push
4. Lancer .\run-suite.ps1
5. Laisser la suite tourner
6. Si quota : attendre le reset puis relancer la même commande
7. Ouvrir suite-summary.md
8. Examiner les résultats intéressants
9. Noter le verdict dans la fiche du prompt
```

C'est tout.
