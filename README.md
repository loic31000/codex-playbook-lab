# Codex Playbook Lab

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/Docker-required%20for%20strict%20runner-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Codex%20CLI-0.160.0-000000?style=for-the-badge" alt="Codex CLI 0.160.0">
  <img src="https://img.shields.io/badge/V2-in%20progress-orange?style=for-the-badge" alt="V2 in progress">
</p>

> **Branche V2.** Ce document décrit l'architecture en cours sur `v2/lab-architecture`.  
> `main` reste la version stable historique jusqu'au cutover final.

Codex Playbook Lab est une couche d'expérimentation **evidence-first** pour mesurer l'effet de playbooks/prompts sur de vrais agents Codex, avec cas fixes et exploratoires, exécutions A/B isolées, preuves factuelles et décision finale explicitement humaine.

## Projet associé

Ce dépôt est le laboratoire du projet [Codex Engineering Playbook FR](https://github.com/loic31000/codex-engineering-playbook-fr).

Le playbook fournit les prompts à évaluer. Le Lab organise les expériences, exécute les agents dans une frontière contrôlée, conserve les preuves techniques et présente les résultats à un reviewer humain.

## Invariant central

Le système automatique **ne décide jamais** qu'un prompt est meilleur, qu'une réponse est qualitativement correcte ou qu'un run doit être validé/refusé.

Il peut enregistrer des faits :

- exit code ;
- durée ;
- tests ;
- TypeScript ;
- diff ;
- fichiers modifiés ;
- fingerprints ;
- événements observés ;
- erreurs techniques.

La décision finale appartient à un humain avec les états :

- **À vérifier** ;
- **Validé** ;
- **Refusé** ;
- **Incertain**.

Dans le domaine V2, `TechnicalStatus` et `HumanReviewStatus` sont volontairement séparés.

Un run peut donc être :

```text
technicalStatus = completed
humanReviewStatus = pending_review
```

sans contradiction.

## État actuel de la V2

| Étape | État |
| --- | --- |
| Architecture native Codex / isolation | ✅ validée par #37 et #39 |
| Domaine Experiment / Evidence / revue humaine (#23) | ✅ mergé via #40 |
| Strict runner production (#24) | 🚧 en cours |
| Benchmarks fixes (#25) | à venir |
| Cas exploratoires générés (#26) | à venir |
| Orchestration d'expériences (#27) | à venir |
| Evidence persistée / reprise (#28) | à venir |
| Revue humaine / promotion (#29) | à venir |
| Rapport factuel (#30) | à venir |
| Couche applicative / CLI (#31) | à venir |
| API / événements (#32) | à venir |
| GUI (#33) | à venir |
| CI / campagne finale / cutover (#34) | à venir |

La roadmap de référence est l'issue #22.

## Architecture d'exécution validée

La phase d'exploration du runner a abouti à l'architecture suivante :

```text
trusted host
ChatGPT OAuth
    │
    ▼
Codex app-server
    │
    │ private inherited stdio
    ▼
docker run --network none
    │
    ▼
Codex exec-server
    │
    ▼
target-only /workspace
```

Cette architecture a été validée par une campagne réelle avec :

- Codex CLI `0.160.0` ;
- Docker `29.6.2` ;
- Windows 10 / Docker Desktop pour la plateforme de preuve.

Les propriétés démontrées comprennent :

- vraie inférence via le plan ChatGPT sans `OPENAI_API_KEY` dans le sandbox ;
- authentification ChatGPT conservée côté host ;
- aucun credential ChatGPT dans le container agent ;
- aucun Docker socket ;
- aucun port publié ;
- `--network none` ;
- aucun accès utile au host ou à Internet dans le sandbox testé ;
- target lisible et modifiable dans `/workspace` ;
- Lab, home host, auth et sentinelles inaccessibles ;
- routage objectif des opérations dans l'environnement distant ;
- workspaces A/B indépendants à état initial identique.

### Portée de cette preuve

Ce résultat ne constitue pas une garantie universelle pour toutes les plateformes ou futures versions de Codex.

Toute évolution de la frontière d'exécution ou de la version Codex doit être revalidée.

L'issue #24 transforme actuellement cette preuve en **runner production réutilisable**. Le code de production ne doit pas dépendre des fichiers du spike.

## Modèle métier V2

La fondation mergée dans `src/domain/` introduit notamment :

- `Experiment` ;
- `PromptDefinition` ;
- `PromptVersion` ;
- `TargetRef` ;
- `TestCase` ;
- `FixedCase` ;
- `GeneratedCase` ;
- `GenerationProvenance` ;
- `ExperimentRun` ;
- `Evidence` ;
- `TechnicalStatus` ;
- `HumanReviewStatus`.

### Target explicite

Le repository du Lab n'est jamais un target implicite.

Un target doit être fourni explicitement par l'appelant. Le futur strict runner doit travailler sur un snapshot indépendant : le dépôt source ne doit pas être modifié par l'agent.

### FixedCase et GeneratedCase

Les deux variantes partagent un contrat `TestCase`.

Un `GeneratedCase` conserve obligatoirement sa provenance. La promotion d'un cas généré en benchmark fixe est une décision humaine et sera traitée dans une étape dédiée.

### Evidence factuelle

`Evidence` accepte des informations factuelles et refuse les concepts de verdict qualitatif tels que `winner`, `betterPrompt`, `approved`, `rejected`, etc.

Principe :

> Les faits techniques appartiennent à Evidence ; la décision appartient à HumanReviewStatus.

## Structure du repository

Les zones importantes pendant la migration V2 sont :

```text
src/
├── domain/                 # domaine V2 déjà intégré
├── core/                   # moteur historique V1, conservé jusqu'au cutover
├── platform/               # helpers plateforme historiques
└── runner/                 # futur strict runner (#24), en cours de construction

spikes/
└── codex-app-exec/         # preuve historique de l'architecture native retenue

tests/
├── domain/                 # tests du domaine V2
└── lab/                    # tests moteur / spikes / non-régression
```

Le spike Inspect AI / inspect-swe a été évalué dans #35/#36 mais **n'a pas été intégré comme fondation du runner V2**.

Les dossiers `spikes/` sont des preuves historiques. Le runtime production ne doit pas les importer.

## Langages et responsabilités

La cible V2 est volontairement simple :

- **TypeScript / Node.js** : domaine, application, runner, evidence, CLI/API ;
- **Bash** : seulement un éventuel bootstrap Linux/container très mince ;
- **PowerShell** : compatibilité/outillage Windows, pas logique métier V2 ;
- **Python** : aucune nouvelle dépendance de production prévue.

La présence de plusieurs langages dans les expériences historiques ne signifie pas que la production V2 repose sur plusieurs couches métier.

La direction recherchée est :

```text
TypeScript / Node
      │
      ▼
    Docker
      │
      ▼
small container bootstrap
      │
      ▼
Codex exec-server
```

## Threat model du strict runner

Le container agent est traité comme potentiellement hostile.

Le strict runner doit garantir que l'agent ne reçoit pas :

- le repository du Lab ;
- les benchmarks/oracles du Lab ;
- le home du host ;
- `auth.json` ;
- les tokens OAuth ;
- une API key ;
- le Docker socket ;
- les résultats d'autres runs ;
- un accès réseau général au host ou à Internet.

Le workspace autorisé doit être un volume/snapshot indépendant monté sur :

```text
/workspace
```

Le dépôt source host ne doit jamais être nettoyé ou réinitialisé pour restaurer un run.

## A/B

BASELINE et AVEC PROMPT doivent commencer depuis le **même état initial vérifiable**, dans deux workspaces indépendants.

La future orchestration doit pouvoir établir factuellement :

```text
baseline.initialFingerprint
===
treatment.initialFingerprint
```

avant l'exécution.

Aucune égalité de résultat ou supériorité qualitative n'est déduite automatiquement de ces faits.

## Développement

Prérequis généraux :

- Node.js 20+ ;
- npm ;
- Git ;
- Docker pour les tests/intégrations du strict runner ;
- Codex CLI authentifié côté host pour les campagnes réelles.

Installation :

```bash
npm install
```

Validation principale :

```bash
npm run test:lab
npm test -- --run
npx tsc --noEmit
git diff --check
```

Les tests automatisés normaux ne doivent pas nécessiter de vraie inférence modèle.

## CLI historique

Le repository contient encore la CLI et les scripts de la V1 pendant la migration.

Ils restent utiles pour la version historique, mais **ils ne constituent pas la frontière de sécurité retenue pour la V2**.

En particulier, les anciennes stratégies basées sur `workspace-write`, bind mounts du dépôt, `git reset --hard` ou `git clean` ne doivent pas être reprises dans le strict runner V2.

Pour la documentation du produit stable actuel, consulter le README de `main`.

## Authentification

La V2 retenue utilise l'authentification ChatGPT côté host avec Codex app-server.

Le sandbox agent ne doit recevoir ni :

- access token ;
- refresh token ;
- id token ;
- `OPENAI_API_KEY` ;
- `auth.json`.

Ne montez pas `CODEX_HOME` ou des credentials host dans le container agent.

## Réseau

La frontière validée utilise :

```text
docker run --network none
```

Le control plane ne dépend pas du réseau du container : il passe par le flux stdio privé hérité entre le host et `exec-server`.

C'est précisément ce découplage qui permet de conserver le contrôle de l'agent sans lui donner un data plane réseau.

## Workflow Git V2

- `main` reste stable jusqu'au cutover ;
- `v2/lab-architecture` est la branche d'intégration ;
- une issue active = une branche dédiée ;
- les branches partent du dernier `v2/lab-architecture` ;
- les PR V2 ciblent `v2/lab-architecture` ;
- aucun merge sans revue et accord humain explicite ;
- une branche terminée ou abandonnée peut être supprimée une fois sa traçabilité conservée par les PR/issues.

## Historique des décisions

- #35 / #36 — Inspect AI / inspect-swe : **partiellement suffisant, voie non retenue dans le chemin critique** ;
- #37 — Codex app-server / exec-server natif : **base retenue sous condition d'isolation réseau** ;
- #38 / #39 — stdio + `--network none` : **H2-A — PASS** ;
- #23 / #40 — domaine Experiment / Evidence / human review : **intégré** ;
- #24 — strict runner production : **en cours**.

Les spikes restent consultables pour comprendre les preuves, mais ils ne définissent pas l'API production.

## Principe de livraison

Chaque issue V2 doit fournir :

- critères d'acceptation explicites ;
- tests ;
- preuves vérifiables ;
- limites connues ;
- revue humaine avant merge.

Une déclaration d'un agent n'est jamais suffisante à elle seule pour accepter une issue.
