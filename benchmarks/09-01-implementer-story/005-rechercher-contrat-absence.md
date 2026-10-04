---
format: codex-lab-benchmark
id: 005-rechercher-contrat-absence
prompt: 09-01-implementer-story
title: Rechercher une tâche avec contrat d’absence non défini
expectation: clarification
---

# Rechercher une tâche

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux pouvoir retrouver une tâche à partir de son identifiant
afin d’accéder directement à une tâche connue.

## Critères d’acceptation

- une fonction publique `findTaskById(tasks, id)` permet de rechercher une tâche ;
- lorsqu’une tâche possède l’identifiant demandé, cette tâche est retournée ;
- la recherche ne modifie ni la collection reçue ni les tâches qu’elle contient ;
- le comportement lorsqu’aucune tâche ne possède l’identifiant demandé est couvert par un test automatisé ;
- des tests automatisés couvrent le comportement demandé.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification du serveur ;
- ajout de dépendances.
