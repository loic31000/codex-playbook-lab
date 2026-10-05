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
           | private inherited stdio pipe (host-initiated docker run -i)
           v
Docker Linux (untrusted)
  --network none
  codex exec-server --listen stdio
  volume nommé /workspace (fixture uniquement)
```

Le contexte de build Docker temporaire ne contient que le Dockerfile,
l'entrypoint et la fixture. À l'exécution, le conteneur reçoit un unique volume
nommé sur `/workspace`. Aucun bind mount, home hôte, `.codex`, `auth.json`,
credential, dépôt Lab ou socket Docker n'est monté.

Le conteneur n'expose aucun listener ni port. `app-server` initie le canal en
lançant `docker run --interactive`; les messages exec-server circulent
uniquement sur les pipes stdin/stdout hérités du processus Docker côté host.
Le credential ChatGPT reste exclusivement dans le processus `app-server` de
confiance et n'est pas transmis au processus Docker.

## Reproduction

Pré-requis : Windows, PowerShell 5.1, Docker Desktop, Node.js, Codex CLI
`0.160.0`, et aucun `OPENAI_API_KEY`/équivalent dans l'environnement.

```powershell
npm install
node --test tests/lab/codex-app-exec-spike.node.mjs
node spikes/codex-app-exec/spike.mjs prepare
node spikes/codex-app-exec/spike.mjs signin
node spikes/codex-app-exec/spike.mjs run-all
node spikes/codex-app-exec/spike.mjs harden
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

`harden` ne lance aucun modèle. Il mesure le réseau et les sentinelles depuis le
même type de conteneur, puis génère `RESULT.md` depuis le dernier `run-all` réel.
Ce résumé commit-able utilise une allowlist et refuse tout credential connu.

## Résultat observé le 5 octobre 2026

- OAuth dynamique : scopes `resource.invoke` et
  `chatgpt.tokens.use.direct` accordés, aucune API key utilisée.
- Inference `openai_chatgpt_plan` via `app-server` : réponse attendue reçue,
  statut `completed`.
- Primitive distante : environnement statique Codex `0.160.0` lançant
  `exec-server --listen stdio` dans `docker run --network none`; cwd retourné
  `file:///workspace`.
- Canal de contrôle : aucun WebSocket, listener ou port publié. Le
  capability-token WebSocket devient sans objet parce qu'aucune surface réseau
  exec-server n'existe dans cette variante.
- Routage : lecture, shell, création, modification, suppression, file change
  (`apply_patch`), Git et tests sont 8/8 `SANDBOX`. Chaque conclusion provient
  des événements persistés (thread/turn, environnement attribué, commande,
  cwd, statut, exit code ou changements de fichiers), jamais du texte agent.
- Probe déterministe : target lisible/inscriptible ; aucune sentinel Lab/OAuth,
  aucun contenu de sentinel, `auth.json`, secret d'environnement, home hôte ou
  socket Docker visible.
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
- Réseau : `networkMode=none`, aucun port publié, seule interface `lo`, aucune
  route IPv4/IPv6 externe. `host.docker.internal`,
  `gateway.docker.internal`, le serveur HTTP factice host, le DNS externe,
  TCP 443, HTTP et HTTPS sont bloqués. Les probes Internet couvrent
  `example.com` et `www.iana.org`.

### Décision

**H2-A — PASS.**

Le control plane, l'isolation réseau, la frontière OAuth/filesystem, le routage
objectif 8/8, la tâche réelle et le mini A/B sont prouvés pour ce run. Cette
conclusion est limitée à Codex `0.160.0`, Docker Desktop `29.6.2` et aux probes
documentées dans `RESULT.md`.

## Limites observées

- Le champ `environments` et `exec-server` sont expérimentaux. Codex
  `0.160.0` est l'unique version validée ; le runner refuse toute autre version
  et une mise à jour exige une nouvelle validation complète du routage.
- Option 1 réfutée sur ce host : un réseau Docker `--internal` ne publiait pas
  le port exec-server. L'option retenue utilise le transport stdio natif et
  `--network none`, sans proxy, firewall, VPN ou daemon custom.
- Le sandbox ne peut accéder à aucun registre de paquets ou autre service
  réseau. Une tâche nécessitant réellement le réseau demande une policy
  distincte et n'est pas couverte par H2-A.
- `app-server` émet des avertissements de conversion de chemins Windows pour
  ses recherches de plugins (`C:\workspace`) alors que les outils distants ont
  bien opéré dans `/workspace`.
- Le warm-up optionnel des plugins côté host a rencontré un `401`, un chemin
  Windows trop long et un `429`; ces erreurs n'ont pas affecté les tours.
- Le stockage DPAPI et le flow navigateur sont Windows-only dans ce spike.
- Une seule répétition A/B a été exécutée ; aucun mérite relatif des prompts
  n'en est déduit.
