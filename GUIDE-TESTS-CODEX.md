# Guide simple - Suite automatique Codex

## Ce que tu fais

Une fois les deux dépôts placés côte à côte :

```text
codex-playbook-tests\
codex-engineering-playbook-fr\
```

ouvre PowerShell dans `codex-playbook-tests`.

Puis :

```powershell
git pull --ff-only origin main
git status
.\run-suite.ps1
```

Tu ne crées plus les cas de test à la main.

Tu ne copies plus les prompts dans Codex.

Tu ne lances plus baseline et avec-prompt séparément.

## Ce que le script fait tout seul

```text
1. Scanne le playbook
2. Détecte tous les fichiers format: prompt
3. Extrait "Prompt prêt à copier"
4. Génère un cas fictif adapté
5. Lance le baseline
6. Reset le dépôt
7. Lance le même cas avec le prompt
8. Reset le dépôt
9. Génère la comparaison
10. Crée un fichier résultat
11. Passe au prompt suivant
12. Crée le résumé global
```

Le générateur de cas reçoit le prompt uniquement pour fabriquer un scénario pertinent.

Le baseline reçoit ensuite uniquement le cas généré.

Le second run reçoit exactement le même cas plus le prompt à évaluer.

## Configuration

Le fichier `tests-suite.json` contient seulement :

```json
{
  "playbook_path": "../codex-engineering-playbook-fr",
  "cases_per_prompt": 1
}
```

Tu n'as normalement rien à modifier.

## Où sont les cas générés

Ils sont créés automatiquement hors du repo Git :

```text
..\codex-playbook-test-runs\generated-cases\
```

Ils ne polluent donc pas le repository de test.

## Où sont les résultats

```text
..\codex-playbook-test-runs\
```

À la fin, commence par ouvrir :

```text
suite-summary.md
```

Pour chaque test, le fichier le plus pratique à analyser est :

```text
auto-xxxxxxxxxxxx-result.md
```

Il contient au même endroit :

```text
cas généré
+
sortie baseline
+
sortie avec prompt
+
diff des fichiers
```

## Si tu arrêtes le script

Relance simplement :

```powershell
.\run-suite.ps1
```

Les tests déjà complets sont sautés.

Les tests partiels reprennent à l'étape manquante.

## Si le quota Codex est atteint

Le script arrête la suite proprement.

Il conserve les étapes déjà valides et retire seulement le run incomplet.

Quand la limite est réinitialisée :

```powershell
.\run-suite.ps1
```

La suite reprend automatiquement.

## Si un prompt change

L'identifiant du test dépend du contenu du prompt.

Donc un prompt modifié obtient automatiquement un nouveau test.

Les anciens résultats ne sont pas écrasés.

## Routine à retenir

```text
git pull --ff-only origin main
git status
.\run-suite.ps1
```

Puis tu analyses les résultats.
