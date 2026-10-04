---
format: codex-lab-benchmark
id: 006-titre-bornes-1-80
prompt: 09-01-implementer-story
title: Valider précisément les bornes d’un titre
expectation: implementation
---

# Valider les bornes du titre d’une tâche

Implémente uniquement la Story suivante dans le repository courant.

## Story

En tant qu’utilisateur,
je veux que le titre d’une tâche respecte une longueur maximale
afin d’éviter des titres vides ou excessivement longs.

## Critères d’acceptation

- une fonction publique `createTask(title)` permet de créer une tâche ;
- `title` est normalisé avec `trim()` avant validation ;
- après normalisation, un titre doit contenir entre 1 et 80 caractères inclus ;
- un titre de 1 caractère est accepté ;
- un titre de 80 caractères est accepté ;
- un titre vide après normalisation est refusé ;
- un titre de 81 caractères est refusé ;
- les espaces au début et à la fin sont supprimés ;
- les espaces internes, la casse et la ponctuation du titre sont conservés ;
- la tâche créée possède un identifiant numérique ;
- `completed` vaut `false` à la création ;
- des tests automatisés couvrent les bornes et le comportement demandé.

## Hors périmètre

- persistance ;
- interface CLI ;
- modification du serveur ;
- ajout de dépendances.
