---
format: codex-lab-benchmark
id: 010-priorite-contrat-complet-multifichier
prompt: 09-01-implementer-story
title: Ajouter une priorité avec contrat métier complet
expectation: implementation
---

# Ajouter une priorité à une tâche

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux pouvoir définir une priorité lors de la création d’une tâche
afin de distinguer les tâches importantes des autres.

## Critères d’acceptation

- le type public `TaskPriority` accepte uniquement `"low"`, `"medium"` ou `"high"` ;
- `Task` possède une propriété `priority: TaskPriority` ;
- une fonction publique `createTask(title, priority?)` permet de créer une tâche ;
- lorsque `priority` est omise, la valeur `"medium"` est utilisée ;
- `title` est normalisé avec `trim()` ;
- un titre vide après normalisation est refusé ;
- la tâche possède un identifiant numérique ;
- `completed` vaut `false` ;
- `src/task.ts` contient les types publics `Task` et `TaskPriority` ;
- `src/task-service.ts` contient `createTask` ;
- `src/index.ts` constitue le point d’entrée public ;
- `Task`, `TaskPriority` et `createTask` sont accessibles depuis `src/index.ts` ;
- les tests importent uniquement depuis `../src/index.js` ;
- les trois valeurs de priorité sont couvertes par les tests ;
- la priorité par défaut `"medium"` est couverte par un test ;
- des tests automatisés couvrent le comportement demandé.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification de `src/server.ts` ;
- ajout de dépendances ;
- autres niveaux de priorité.
