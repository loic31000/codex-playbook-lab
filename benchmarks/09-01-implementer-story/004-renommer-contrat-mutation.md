---
format: codex-lab-benchmark
id: 004-renommer-contrat-mutation
prompt: 09-01-implementer-story
title: Renommer une tâche
expectation: clarification
---

# Renommer une tâche

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux pouvoir renommer une tâche existante
afin de corriger ou préciser son titre.

## Critères d’acceptation

- une fonction publique `renameTask(task, newTitle)` permet de renommer une tâche ;
- `newTitle` est normalisé avec `trim()` ;
- un titre vide après normalisation est refusé ;
- l’identifiant de la tâche est conservé ;
- la valeur de `completed` est conservée ;
- la fonction retourne une `Task` ;
- des tests automatisés couvrent le comportement demandé.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification du serveur ;
- ajout de dépendances.
