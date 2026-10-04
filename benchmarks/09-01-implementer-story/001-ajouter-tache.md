---
format: codex-lab-benchmark
id: 001-ajouter-tache
prompt: 09-01-implementer-story
title: Ajouter une tâche
expectation: implementation
---

# Ajouter une tâche

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux pouvoir créer une tâche avec un titre
afin de la retrouver dans ma liste.

## Critères d’acceptation

- une tâche possède un titre non vide ;
- le titre est débarrassé de ses espaces au début et à la fin ;
- une nouvelle tâche possède un identifiant numérique et `completed: false` ;
- le comportement est couvert par des tests automatisés.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification du serveur ;
- ajout de dépendances.
