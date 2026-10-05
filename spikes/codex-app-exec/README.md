# Spike `app-server` → `exec-server`

Ce spike vérifie une seule hypothèse : un `codex app-server` de confiance sur
Windows peut piloter un `codex exec-server` Linux non fiable, sans transmettre
au conteneur l'authentification ChatGPT ni le dépôt du Lab.

## Frontière testée

```text
Windows (trusted)
  spike.mjs
  OAuth ChatGPT-plan + DPAPI
  codex app-server
           |
           | JSON-RPC environment/add, WebSocket loopback
           v
Docker Linux (untrusted)
  codex exec-server
  volume nommé /workspace (fixture uniquement)
```

Le contexte de build Docker temporaire ne contient que le Dockerfile,
l'entrypoint et la fixture. À l'exécution, le conteneur reçoit un unique volume
nommé sur `/workspace`. Aucun bind mount, home hôte, `.codex`, `auth.json`,
credential, dépôt Lab ou socket Docker n'est monté.

## Reproduction

Pré-requis : Windows, PowerShell 5.1, Docker Desktop, Node.js, Codex CLI
`0.160.0`, et aucun `OPENAI_API_KEY`/équivalent dans l'environnement.

```powershell
npm install
node --test tests/lab/codex-app-exec-spike.node.mjs
node spikes/codex-app-exec/spike.mjs prepare
node spikes/codex-app-exec/spike.mjs signin
node spikes/codex-app-exec/spike.mjs run-all
```

`signin` ouvre le navigateur pour le consentement. Les access, refresh et ID
tokens sont chiffrés par DPAPI CurrentUser dans
`%LOCALAPPDATA%\CodexPlaybookLab\app-exec-oauth\credentials.dpapi`, hors du
dépôt. Les métadonnées non secrètes et l'identifiant stable du host sont
stockés dans le même dossier. Le refresh utilise le client émis, le refresh
token et la resource officielle, sans renvoyer les scopes. Il faut redémarrer
`app-server` après un refresh ; ce runner le démarre après acquisition du
credential.

Les preuves locales JSON sont écrites dans `evidence/`, ignoré par Git. Elles
refusent la sérialisation du jeton connu et redacted les formes Bearer. Elles ne
doivent jamais être publiées sans une nouvelle revue de secrets.

## Résultat observé le 5 octobre 2026

- OAuth dynamique : scopes `resource.invoke` et
  `chatgpt.tokens.use.direct` accordés, aucune API key utilisée.
- Inference `openai_chatgpt_plan` via `app-server` : réponse attendue reçue,
  statut `completed`.
- Primitive distante : `environment/add` vers le WebSocket loopback publié par
  `exec-server`, cwd retourné `file:///workspace`.
- Routage : lecture, shell, création, modification, suppression, file change
  (`apply_patch`), Git et tests observés dans le conteneur ; le snapshot Git du
  Lab est resté identique avant/après.
- Probe déterministe : target lisible/inscriptible ; aucune sentinel Lab/OAuth,
  aucun `auth.json`, secret d'environnement, home hôte ou socket Docker visible.
- Probe Codex adversariale : aucune sentinel ni credential réel confirmé, aucun
  socket Docker ; résultat cohérent avec la probe déterministe.
- Tâche réelle : test initial en échec, `src/math.cjs` seul modifié de `a - b`
  vers `a + b`, test final réussi.
- Mini A/B : commit initial
  `96bbdd2cf9cd8b01f21d77759bb8b5b190f4bf44`, tree initial
  `3dd7d2e919328ec962f8cb90ea4b2e5c717ff94d`, deux volumes nommés distincts,
  modèle `gpt-6.1-sol`, effort `medium`, Codex `0.160.0`. Les deux bras ont
  produit le même diff minimal et un test vert. Seul le traitement recevait
  l'instruction additionnelle déterministe.

Conclusion technique du spike : **DECISION A — Codex natif retenu** pour cette
frontière expérimentale. Cette conclusion prouve le chemin testé, pas une
isolation formelle ni une architecture V2 complète.

## Limites observées

- L'API `environment/add` et le champ `environments` nécessitent la capability
  expérimentale d'`app-server` dans Codex `0.160.0`.
- Le réseau Docker dédié n'est pas `--internal` : Docker Desktop ne publiait
  alors pas le port loopback nécessaire. Le conteneur conserve donc un egress,
  mais ne contient aucun credential à exfiltrer.
- `app-server` émet des avertissements de conversion de chemins Windows pour
  ses recherches de plugins (`C:\workspace`) alors que les outils distants ont
  bien opéré dans `/workspace`.
- Le warm-up optionnel des plugins côté host a rencontré un `401`, un chemin
  Windows trop long et un `429`; ces erreurs n'ont pas affecté les tours.
- Le premier essai `apply_patch` de l'agent était invalide, puis sa seconde
  tentative a réussi dans le target.
- Le stockage DPAPI et le flow navigateur sont Windows-only dans ce spike.
- Une seule répétition A/B a été exécutée ; aucun mérite relatif des prompts
  n'en est déduit.
