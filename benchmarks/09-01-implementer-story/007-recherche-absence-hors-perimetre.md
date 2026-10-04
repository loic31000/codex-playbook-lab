---
format: codex-lab-benchmark
id: 007-recherche-absence-hors-perimetre
prompt: 09-01-implementer-story
title: Rechercher une tâche sans définir le cas absent
expectation: implementation
---

# Rechercher une tâche existante

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux pouvoir retrouver une tâche existante à partir de son identifiant
afin d’accéder directement à cette tâche.

## Critères d’acceptation

- une fonction publique `findTaskById(tasks, id)` permet de rechercher une tâche ;
- lorsqu’une tâche possède l’identifiant demandé, cette tâche est retournée ;
- la recherche ne modifie ni la collection reçue ni les tâches qu’elle contient ;
- des tests automatisés couvrent la recherche d’une tâche existante.

## Hors périmètre

- comportement lorsqu’aucune tâche ne possède l’identifiant demandé ;
- persistance ;
- interface CLI ;
- modification du serveur ;
- ajout de dépendances.
