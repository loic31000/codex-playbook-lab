# Codex Playbook Tests

Banc de test automatique pour les prompts du Codex Engineering Playbook.

## Utilisation normale

Depuis la racine de ce dépôt :

```powershell
git pull --ff-only origin main
git status
.\run-suite.ps1
```

C'est tout.

Tu n'as plus à écrire les cas de test un par un.

## Ce que fait run-suite.ps1

Le script :

1. trouve automatiquement le playbook ;
2. scanne tous les fichiers Markdown ;
3. garde les fichiers `format: prompt` contenant `## Prompt prêt à copier` ;
4. génère automatiquement un cas fictif adapté à chaque prompt ;
5. lance Codex sans le prompt ;
6. remet le dépôt dans son état initial ;
7. lance Codex avec le même cas et le prompt ;
8. génère la comparaison ;
9. passe au prompt suivant ;
10. écrit un résumé global.

Schéma :

```text
playbook
   |
   v
détection des prompts
   |
   v
génération automatique du cas
   |
   +--> baseline sans prompt
   |
   +--> même cas avec prompt
   |
   v
comparaison
   |
   v
prompt suivant
   |
   v
suite-summary.md
```

## Configuration

`tests-suite.json` ne contient plus la liste des tests.

Il contient seulement la configuration :

```json
{
  "playbook_path": "../codex-engineering-playbook-fr",
  "cases_per_prompt": 1
}
```

`cases_per_prompt: 1` signifie qu'un cas fictif est généré pour chaque prompt.

## Reprise automatique

Les résultats ont un identifiant calculé à partir du chemin et du contenu du prompt.

Donc :

- un test déjà terminé est sauté ;
- un test interrompu reprend à l'étape manquante ;
- si le texte du prompt change, un nouvel identifiant est créé et le prompt est retesté ;
- les anciens résultats restent disponibles.

Si Codex atteint une limite de quota ou de rate limit, la suite s'arrête proprement.

Après réinitialisation de la limite :

```powershell
.\run-suite.ps1
```

La suite reprend automatiquement.

## Résultats

Les résultats restent hors du dépôt Git :

```text
..\codex-playbook-test-runs\
```

Les résultats sont regroupés dans un dossier lisible par prompt :

```text
suite-summary.md
generated-manifest.json

01-04-inconnues-hypotheses\
  result.md
  case.md
  diff.patch
  generation.log
  fingerprint.txt
  base\
  prompt\
```

Le nom du dossier reprend la section, le numéro du prompt et un titre court. Le hash technique reste uniquement dans les métadonnées internes.

`result.md` rassemble pour un test :

- le cas généré ;
- la sortie baseline ;
- la sortie avec prompt ;
- le diff des fichiers produits.

Les anciens résultats nommés `auto-...` sont migrés automatiquement vers cette structure lors du prochain lancement.

Les anciens cas manuels dans `tests-cases\` peuvent rester comme historique, mais ils ne sont plus nécessaires au fonctionnement automatique.

Guide détaillé : [GUIDE-TESTS-CODEX.md](GUIDE-TESTS-CODEX.md)
