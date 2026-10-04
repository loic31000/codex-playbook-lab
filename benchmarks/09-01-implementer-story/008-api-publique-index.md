---
format: codex-lab-benchmark
id: 008-api-publique-index
prompt: 09-01-implementer-story
title: Exposer une création de tâche via l’API publique
expectation: implementation
---

# Exposer la création d’une tâche via l’API publique

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant que consommateur du module,
je veux pouvoir créer une tâche via le point d’entrée public
afin de ne pas dépendre directement de l’organisation interne des fichiers.

## Critères d’acceptation

- `src/task.ts` expose le type `Task` ;
- une fonction publique `createTask(title)` permet de créer une tâche ;
- `title` est normalisé avec `trim()` ;
- un titre vide après normalisation est refusé ;
- la tâche créée possède un identifiant numérique ;
- `completed` vaut `false` à la création ;
- un fichier `src/index.ts` constitue le point d’entrée public ;
- `Task` et `createTask` sont accessibles depuis `src/index.ts` ;
- les tests importent l’API testée uniquement depuis `../src/index.js` ;
- des tests automatisés couvrent le comportement demandé.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification de `src/server.ts` ;
- ajout de dépendances ;
- réorganisation générale du projet.
