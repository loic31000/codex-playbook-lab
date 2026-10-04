---
format: codex-lab-benchmark
id: 009-validation-titre-partagee
prompt: 09-01-implementer-story
title: Partager la validation du titre entre création et renommage
expectation: implementation
---

# Partager la validation du titre d’une tâche

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant que mainteneur,
je veux que la création et le renommage d’une tâche appliquent exactement les mêmes règles de titre
afin d’éviter que ces comportements divergent.

## Critères d’acceptation

- `createTask(title)` permet de créer une tâche ;
- `renameTask(task, newTitle)` permet de renommer une tâche ;
- `renameTask(task, newTitle)` retourne une nouvelle `Task` ;
- la `Task` reçue n’est pas modifiée ;
- les deux opérations normalisent le titre avec `trim()` ;
- les deux opérations refusent un titre vide après normalisation ;
- la règle de normalisation et validation du titre est définie une seule fois dans un module dédié ;
- `createTask` et `renameTask` réutilisent cette même règle ;
- la tâche retournée conserve `id` et `completed` ;
- `src/index.ts` expose l’API publique nécessaire ;
- les tests utilisent le point d’entrée public ;
- des tests automatisés couvrent création, renommage et validation commune.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification de `src/server.ts` ;
- ajout de dépendances ;
- framework de validation générique.
