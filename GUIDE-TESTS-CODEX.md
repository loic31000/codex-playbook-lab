# Guide simple - Tester un prompt avec Codex

Ce dépôt sert à comparer deux exécutions du même cas de test :

- Codex sans prompt du playbook ;
- Codex avec un prompt du playbook.

Le script `run-test.ps1` automatise entièrement ces deux runs.

Tu ne copies jamais le prompt manuellement dans Codex.

Tu indiques simplement le fichier du prompt avec `-PromptPath`.

---

## 1. Avant de commencer

Place-toi dans le dépôt :

```powershell
cd C:\Users\sion\codex-playbook-tests
```

Récupère les dernières modifications :

```powershell
git pull --ff-only origin main
```

Vérifie que le dépôt est propre :

```powershell
git status
```

Tu dois avoir :

```text
nothing to commit, working tree clean
```

---

## 2. Créer un cas de test

Crée un fichier dans :

```text
tests-cases/
```

Exemple :

```text
tests-cases/004-code-review.md
```

Le fichier contient uniquement le scénario à tester.

Exemple :

```markdown
# Test 004 - Code review

Analyse le code fourni et identifie les problèmes importants.

Contexte :
- ...
- ...

Résultat attendu :
- ...
```

---

## 3. Committer le cas de test

Avant de lancer le test :

```powershell
git add .
git commit -m "test: add scenario 004"
git push origin main
```

Le cas doit être présent dans Git avant l'exécution.

---

## 4. Indiquer le prompt à tester

Tu ne colles pas le prompt dans Codex.

Le script reçoit simplement le chemin du fichier avec `-PromptPath`.

Exemple :

```powershell
-PromptPath "..\codex-engineering-playbook-fr\11-Review-Convergence\01 - Code review.md"
```

Le script ouvre automatiquement ce fichier et extrait uniquement le contenu placé sous :

```text
## Prompt prêt à copier
```

Le reste de la fiche du prompt n'est pas envoyé à Codex.

---

## 5. Lancer le test automatique

Commande complète :

```powershell
.\run-test.ps1 `
  -Id "004" `
  -Case "tests-cases/004-code-review.md" `
  -PromptPath "..\codex-engineering-playbook-fr\11-Review-Convergence\01 - Code review.md"
```

À adapter :

- `-Id` : numéro du test ;
- `-Case` : fichier du scénario ;
- `-PromptPath` : fichier du prompt du playbook.

---

## 6. Ce que le script envoie à Codex

### Run baseline

Le script lance Codex avec le cas de test uniquement.

Le prompt du playbook n'est pas utilisé.

```text
Cas de test
    ↓
Codex
```

### Run avec prompt

Après réinitialisation du dépôt, le script lit automatiquement `-PromptPath`, extrait `Prompt prêt à copier`, puis ajoute exactement le même cas de test.

```text
Prompt prêt à copier
+
même cas de test
    ↓
Codex
```

Tu n'as aucune insertion manuelle à faire entre les deux runs.

---

## 7. Ce que le script fait automatiquement

```text
vérification de Git
    ↓
baseline sans prompt
    ↓
sauvegarde du run
    ↓
reset du dépôt
    ↓
lecture automatique de PromptPath
    ↓
run avec le prompt
    ↓
sauvegarde du run
    ↓
reset du dépôt
    ↓
génération du diff de comparaison
```

Tu n'as plus besoin de lancer manuellement les deux runs ni `save-run.ps1`.

---

## 8. Où trouver les résultats

Les résultats sont enregistrés à côté du dépôt :

```text
C:\Users\sion\codex-playbook-test-runs\
```

Pour le test `004` :

```text
004-baseline\
004-with-prompt\
004-comparison.diff
```

Chaque dossier contient notamment :

```text
codex-final.txt
codex-input.txt
diff.patch
files-list.txt
tests.txt
typescript.txt
diff-check.txt
summary.txt
files\
```

Le fichier :

```text
004-comparison.diff
```

contient les différences entre les fichiers produits par le baseline et ceux produits avec le prompt.

---

## 9. Noter le résultat dans la fiche du prompt

Après comparaison manuelle, garde seulement un résumé court dans la fiche du prompt.

Exemple :

```markdown
### Test 004 - Code review

**Baseline :** réussi
**Avec prompt :** réussi

**Gains observés :**
- meilleure priorisation ;
- moins de faux positifs.

**Point à surveiller :**
- ...

**Conclusion :** positif, à confirmer.

**Décision :** conserver le prompt sans modification.
```

Les preuves détaillées restent dans `codex-playbook-test-runs`.

---

## Routine à retenir

```text
1. Créer un cas de test
2. Commit + push
3. Indiquer le fichier du prompt avec -PromptPath
4. Lancer run-test.ps1
5. Examiner baseline, with-prompt et comparison.diff
6. Noter le verdict dans la fiche du prompt
```

C'est tout.
