# Guide simple — Tester un prompt avec Codex

Ce dépôt sert à comparer :

- **Codex sans prompt personnalisé** ;
- **Codex avec un prompt du playbook**.

Le script `run-test.ps1` automatise les deux runs, sauvegarde les résultats et génère un diff de comparaison.

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
# Test 004 — Code review

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

## 4. Lancer le test automatique

Commande générale :

```powershell
.\run-test.ps1 `
  -Id "004" `
  -Case "tests-cases/004-code-review.md" `
  -PromptPath "..\codex-engineering-playbook-fr\11-Review-Convergence\01 - Code review.md"
```

À adapter :

- `-Id` : numéro du test ;
- `-Case` : fichier du scénario ;
- `-PromptPath` : prompt du playbook à tester.

Le script lit automatiquement uniquement la section :

```text
## Prompt prêt à copier
```

du fichier du playbook.

---

## 5. Ce que le script fait automatiquement

```text
état Git propre
    ↓
run Codex sans prompt
    ↓
sauvegarde du baseline
    ↓
reset du dépôt
    ↓
run Codex avec le prompt
    ↓
sauvegarde du second run
    ↓
reset du dépôt
    ↓
génération du diff de comparaison
```

Tu n'as plus besoin de lancer manuellement les deux runs ni `save-run.ps1`.

---

## 6. Où trouver les résultats

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

---

## 7. Comparer avec ChatGPT

Après le test, envoie simplement :

```text
004-comparison.diff
```

ainsi que :

```text
004-baseline\codex-final.txt
004-with-prompt\codex-final.txt
```

On compare ensuite manuellement :

- ce que le baseline a fait ;
- ce que le prompt a changé ;
- les gains ;
- les régressions éventuelles ;
- le verdict du test.

---

## 8. Résultat à ajouter dans la fiche du prompt

Garde seulement un résumé court.

Exemple :

```markdown
### Test 004 — Code review

**Baseline :** ✅ réussi  
**Avec prompt :** ✅ réussi

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
1. Créer un cas
2. Commit + push
3. Lancer run-test.ps1
4. Envoyer les 3 résultats
5. Comparer
6. Noter le verdict
```

C'est tout.
