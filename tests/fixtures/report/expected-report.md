# Rapport d’expérience

> État : COMPLÈTE

## Source

- Plan : complete\-report\-plan
- Fingerprint du plan : 27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe
- Référence du plan : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/plan\.json
- PlannedRun : 4
- Checkpoint : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/checkpoints/00000010\.json
- Séquence checkpoint : 10
- Fingerprint état : 9a157d521e78fc865f2caef89300fbdeaa39e891c7956176a44e0b27b211eeeb
- Statut orchestration : completed\_with\_failures

## État de l’expérience

- Complète : oui
- Raisons de non-complétude : aucun

## Synthèse technique

| Statut technique | Nombre | PlannedRun sources |
| --- | ---: | --- |
| pending | 0 | aucun |
| running | 0 | aucun |
| completed | 3 | complete\-report\-plan\-0001\-3c8681e17043, complete\-report\-plan\-0003\-faa39f732202, complete\-report\-plan\-0004\-2be0ce3b4a93 |
| failed | 1 | complete\-report\-plan\-0002\-65b20117992f |
| cancelled | 0 | aucun |

Durées connues : 4 run(s), total factuel 450 ms.

| PlannedRun | Durée (ms) | Manifest source |
| --- | ---: | --- |
| complete\-report\-plan\-0001\-3c8681e17043 | 100 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMS0zYzg2ODFlMTcwNDM/attempt\-0001/manifest\.json |
| complete\-report\-plan\-0002\-65b20117992f | 150 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMi02NWIyMDExNzk5MmY/attempt\-0001/manifest\.json |
| complete\-report\-plan\-0003\-faa39f732202 | 90 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMy1mYWEzOWY3MzIyMDI/attempt\-0001/manifest\.json |
| complete\-report\-plan\-0004\-2be0ce3b4a93 | 110 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwNC0yYmUwY2UzYjRhOTM/attempt\-0001/manifest\.json |

Runs avec état workspace connu : 4.
Runs avec modifications : 3 (complete\-report\-plan\-0001\-3c8681e17043, complete\-report\-plan\-0002\-65b20117992f, complete\-report\-plan\-0004\-2be0ce3b4a93).
Runs sans modification constatée : 1 (complete\-report\-plan\-0003\-faa39f732202).
Union des fichiers modifiés : src/base\-only\.ts, src/case\-two\.ts, src/shared\.ts, src/treatment\-only\.ts.

## Revue humaine

| PlannedRun | Décision humaine courante | Origine | Reviewer | Date | Commentaire humain |
| --- | --- | --- | --- | --- | --- |
| complete\-report\-plan\-0001\-3c8681e17043 | Validé | human\_action | Alice \| QA | 2026\-10\-09T10:00:00\.000Z | Human \*\*comment\*\*<br>\# alpha |
| complete\-report\-plan\-0002\-65b20117992f | Refusé | human\_action | Bob | 2026\-10\-09T10:01:00\.000Z | Observed failure |
| complete\-report\-plan\-0003\-faa39f732202 | À vérifier | default\_pending | non disponible | non disponible | non disponible |
| complete\-report\-plan\-0004\-2be0ce3b4a93 | Incertain | human\_action | Chloé | 2026\-10\-09T10:02:00\.000Z | Needs follow\-up |

Actions humaines enregistrées : 3.

## Runs à vérifier

- complete\-report\-plan\-0003\-faa39f732202 — TestCase case\-beta, baseline, répétition 1, statut technique completed, attempt 1, manifest plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMy1mYWEzOWY3MzIyMDI/attempt\-0001/manifest\.json

## Runs

| PlannedRun | TestCase | Type | Variante | Répétition | Attempt | Statut technique | Exit code | Durée (ms) | Manifest |
| --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| complete\-report\-plan\-0001\-3c8681e17043 | case\-alpha | fixed | baseline | 1 | 1 | completed | 0 | 100 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMS0zYzg2ODFlMTcwNDM/attempt\-0001/manifest\.json |
| complete\-report\-plan\-0002\-65b20117992f | case\-alpha | fixed | treatment | 1 | 1 | failed | 2 | 150 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMi02NWIyMDExNzk5MmY/attempt\-0001/manifest\.json |
| complete\-report\-plan\-0003\-faa39f732202 | case\-beta | fixed | baseline | 1 | 1 | completed | 0 | 90 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMy1mYWEzOWY3MzIyMDI/attempt\-0001/manifest\.json |
| complete\-report\-plan\-0004\-2be0ce3b4a93 | case\-beta | fixed | treatment | 1 | 1 | completed | 0 | 110 | plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwNC0yYmUwY2UzYjRhOTM/attempt\-0001/manifest\.json |

### Historique des attempts

#### complete\-report\-plan\-0001\-3c8681e17043

- Attempt 1 : finalized ; started plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMS0zYzg2ODFlMTcwNDM/attempt\-0001/started\.json ; manifest plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMS0zYzg2ODFlMTcwNDM/attempt\-0001/manifest\.json

#### complete\-report\-plan\-0002\-65b20117992f

- Attempt 1 : finalized ; started plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMi02NWIyMDExNzk5MmY/attempt\-0001/started\.json ; manifest plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMi02NWIyMDExNzk5MmY/attempt\-0001/manifest\.json

#### complete\-report\-plan\-0003\-faa39f732202

- Attempt 1 : finalized ; started plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMy1mYWEzOWY3MzIyMDI/attempt\-0001/started\.json ; manifest plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMy1mYWEzOWY3MzIyMDI/attempt\-0001/manifest\.json

#### complete\-report\-plan\-0004\-2be0ce3b4a93

- Attempt 1 : finalized ; started plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwNC0yYmUwY2UzYjRhOTM/attempt\-0001/started\.json ; manifest plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwNC0yYmUwY2UzYjRhOTM/attempt\-0001/manifest\.json

## Comparaisons BASELINE / AVEC PROMPT

### report\-experiment / case\-alpha / répétition 1

- Comparaison factuellement complète : oui
- Faits manquants : aucun
- BASELINE : complete\-report\-plan\-0001\-3c8681e17043, statut completed, exit code 0, durée 100 ms
- AVEC PROMPT : complete\-report\-plan\-0002\-65b20117992f, statut failed, exit code 2, durée 150 ms
- Différence de durée AVEC PROMPT moins BASELINE : 50 ms
- Fichiers partagés : src/shared\.ts
- Fichiers BASELINE uniquement : src/base\-only\.ts
- Fichiers AVEC PROMPT uniquement : src/treatment\-only\.ts

### report\-experiment / case\-beta / répétition 1

- Comparaison factuellement complète : oui
- Faits manquants : aucun
- BASELINE : complete\-report\-plan\-0003\-faa39f732202, statut completed, exit code 0, durée 90 ms
- AVEC PROMPT : complete\-report\-plan\-0004\-2be0ce3b4a93, statut completed, exit code 0, durée 110 ms
- Différence de durée AVEC PROMPT moins BASELINE : 20 ms
- Fichiers partagés : aucun
- Fichiers BASELINE uniquement : aucun
- Fichiers AVEC PROMPT uniquement : src/case\-two\.ts

## Evidence et métriques

| Type Evidence | Nombre | Sources |
| --- | ---: | --- |
| command\-execution | 4 | complete\-report\-plan\-0001\-3c8681e17043\#2, complete\-report\-plan\-0002\-65b20117992f\#2, complete\-report\-plan\-0003\-faa39f732202\#2, complete\-report\-plan\-0004\-2be0ce3b4a93\#2 |
| test\-result | 8 | complete\-report\-plan\-0001\-3c8681e17043\#0, complete\-report\-plan\-0001\-3c8681e17043\#1, complete\-report\-plan\-0002\-65b20117992f\#0, complete\-report\-plan\-0002\-65b20117992f\#1, complete\-report\-plan\-0003\-faa39f732202\#0, complete\-report\-plan\-0003\-faa39f732202\#1, complete\-report\-plan\-0004\-2be0ce3b4a93\#0, complete\-report\-plan\-0004\-2be0ce3b4a93\#1 |

| Métrique | Unité | Observations | Somme | Min | Max |
| --- | --- | ---: | ---: | ---: | ---: |
| tests\.failed | count | 4 | 1 | 0 | 1 |
| tests\.passed | count | 4 | 13 | 2 | 4 |

## Traçabilité

- Plan : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/plan\.json
- Checkpoint : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/checkpoints/00000010\.json
- Manifest complete\-report\-plan\-0001\-3c8681e17043 : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMS0zYzg2ODFlMTcwNDM/attempt\-0001/manifest\.json (0c615c9a38cf8f57c42e01a08dcfe2723922e6b30b474172f76b420a97ecaf1a)
- Action humaine complete\-report\-plan\-0001\-3c8681e17043#1 : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/reviews/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMS0zYzg2ODFlMTcwNDM/00000001\.json (b0bdebf7322e582e3b2785151272df119aeb93841f989e9d68ee13f19ed1f094)
- Manifest complete\-report\-plan\-0002\-65b20117992f : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMi02NWIyMDExNzk5MmY/attempt\-0001/manifest\.json (e25fe647bcda4368f374c415bfa813f270242dd187300ea042c62e7b58aba573)
- Action humaine complete\-report\-plan\-0002\-65b20117992f#1 : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/reviews/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMi02NWIyMDExNzk5MmY/00000001\.json (a0c09eb90a5518053f8aa8872a120b04f189af9d3de8cc47d6af4586e961194a)
- Manifest complete\-report\-plan\-0003\-faa39f732202 : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwMy1mYWEzOWY3MzIyMDI/attempt\-0001/manifest\.json (f5b9e39603d3f41794d57af548fee504f0b1ed362c9a8711ae27c7f9fb181ce4)
- Manifest complete\-report\-plan\-0004\-2be0ce3b4a93 : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/runs/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwNC0yYmUwY2UzYjRhOTM/attempt\-0001/manifest\.json (1355147788e1dd7af3dc399ae14a2a2af1426193e94e974bfa3b68c16c82f95f)
- Action humaine complete\-report\-plan\-0004\-2be0ce3b4a93#1 : plans/27c256a1a797a9134b365a07688c4d1737b1f1b50b3d084befa2abcb0e32aebe/reviews/Y29tcGxldGUtcmVwb3J0LXBsYW4tMDAwNC0yYmUwY2UzYjRhOTM/00000001\.json (93c6db8439fcae884620f657d6b5a942085e48ff0f327629d46f4704994b2abb)
