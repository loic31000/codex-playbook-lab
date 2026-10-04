---
format: codex-lab-benchmark
id: 002-priorite-ambiguite
prompt: 09-01-implementer-story
title: Ajouter une priorité aux tâches
expectation: clarification
---

# Ajouter une priorité aux tâches

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux pouvoir attribuer une priorité à une tâche
afin d’identifier rapidement les tâches importantes.

## Critères d’acceptation

- une tâche possède une priorité ;
- si aucune priorité n’est fournie, une priorité par défaut est utilisée ;
- la priorité est retournée avec la tâche créée ;
- la fonctionnalité est couverte par des tests automatisés.

Les valeurs de priorité autorisées et la priorité par défaut ne sont pas définies dans cette Story.

## Hors périmètre

- persistance ;
- interface CLI ;
- ajout de dépendances.
