# Spike #35 — Inspect AI, inspect-swe et Codex CLI

Ce spike vérifie uniquement si Inspect peut fournir le socle technique du futur runner. Il n'implémente ni le modèle métier V2, ni un stockage de résultats Lab, ni un juge sémantique.

## Environnement observé

- hôte : Windows 10 Professionnel 10.0.19045 (build 19045) ;
- Docker client et serveur : 29.6.2 ;
- Python géré par `uv` : 3.14.3 ;
- Inspect AI : 0.3.276 ;
- inspect-swe : 0.2.71 ;
- client OpenAI Python requis par l'agent bridge : 3.1.0 ;
- Codex CLI : 0.160.0 ;
- Node.js : 24.19.0 ; npm : 11.17.0.

Les dépendances Python sont confinées à ce dossier par `pyproject.toml` et `uv.lock`. Elles n'imposent aucune migration Python au reste du dépôt.

## Fixture et architecture minimale

`../../fixtures/inspect-spike-target` est un petit projet Node indépendant : `src/math.cjs` soustrait au lieu d'additionner et `test/math.check.cjs` échoue. La tâche est de corriger uniquement `add`, sans modifier les tests ni ajouter de dépendance. Le suffixe `.check.cjs` évite que Vitest, lancé à la racine du Lab, n'absorbe ce test volontairement rouge ; `npm test` dans la fixture le cible explicitement.

`spike_eval.py` définit quatre tâches Inspect :

- `isolation_probe`, preuve objective exécutée dans le même type de sandbox Docker ;
- `codex_spike(variant="baseline")`, cas seul ;
- `codex_spike(variant="prompt")`, même cas avec un system prompt additionnel identifiable ;
- `resume_probe`, interruption contrôlée utilisée par le test de reprise.

Le scorer Codex exécute seulement `npm test`, `git status`, `git diff` et `git rev-parse`. Il ne juge pas la qualité de la réponse avec un modèle.

## Lancer les preuves

Depuis ce dossier :

```powershell
uv sync --frozen
uv run --project . python -m unittest discover -s tests -v
uv run --project . inspect eval spike_eval.py@isolation_probe --model mockllm/model --log-dir logs/isolation --display plain
uv run --project . inspect eval spike_eval.py@codex_spike -T variant=baseline --model openai/gpt-5 --log-dir logs/baseline --display plain --max-retries 0
uv run --project . inspect eval spike_eval.py@codex_spike -T variant=prompt --model openai/gpt-5 --log-dir logs/prompt --display plain --max-retries 0
```

Les deux dernières commandes nécessitent `OPENAI_API_KEY`, `AZUREAI_OPENAI_API_KEY` ou une identité managée prise en charge par Inspect. La valeur du credential ne doit jamais être écrite dans le dépôt ni affichée.

## Isolation réellement observée

Inspect construit le conteneur depuis `Dockerfile`. `Sample.files` copie uniquement le contenu de la fixture dans `/workspace`; le dépôt Lab n'est pas monté. Codex est configuré en `danger-full-access` **dans** ce conteneur, la frontière de sécurité étant le sandbox Docker externe.

Le probe persistant a donné :

```text
status=success
score=C
target_readable=true
target_writable=true
lab_sentinel_matches=[]
lab_sentinel_content_matches=[]
docker_socket_visible=false
event_count=25
```

Un second lancement avec conservation temporaire du sandbox, suivi de `docker inspect`, a donné :

```text
Mounts=[]
HostConfig.NetworkMode="none"
```

`/proc/self/mountinfo` ne contient aucun montage `/workspace`, `/opt/inspect` ou `docker.sock`; seuls les fichiers Docker ordinaires tels que `/etc/hosts` et `/etc/resolv.conf` apparaissent dans le filtre. Le target est donc copié dans la couche du conteneur, et non exposé par bind mount. La recherche par nom sur tout le système de fichiers et la recherche du contenu unique de `fixtures/inspect-spike-lab-sentinel.txt` ne trouvent rien. Le home Windows, les benchmarks, les oracles, les anciens résultats et les fichiers d'authentification hôte ne sont pas montés. Aucun socket sensible observé n'est accessible.

Inspect relaie les requêtes du Codex CLI sandboxé vers son agent bridge sur l'hôte. Les credentials du fournisseur restent consommés par Inspect côté hôte ; aucun fichier d'authentification Codex de l'utilisateur n'est injecté dans le conteneur.

## Codex et comparaison A/B

Une exécution via inspect-swe a réellement lancé le binaire sandboxé :

```text
OpenAI Codex v0.160.0
workdir: /workspace
provider: openai-proxy
approval: never
sandbox: danger-full-access
```

Le transport complet Inspect → inspect-swe → vrai Codex CLI → agent bridge a été exécuté pour BASELINE et AVEC PROMPT avec `mockllm/model`. Ces deux exécutions prouvent l'intégration du processus, mais pas la qualité d'une inférence OpenAI : le modèle simulé n'a pas corrigé la fixture et les tests sont restés rouges. Une tentative distincte avec `openai/gpt-5` s'est arrêtée honnêtement avant le run, car aucun credential OpenAI/Azure n'était présent : `Unable to initialise OpenAI client`.

Chaque run repart d'une copie neuve de la même fixture. Le checksum SHA-256 déterministe initial observé dans les deux logs est :

```text
aab3e18cd1cefcc8dc21aae834b24e8ec6abcdeced69101a5065345ddef016ab
```

Le test A/B recalcule ce hash pour les deux copies, modifie ensuite chaque côté séparément et vérifie l'absence d'effet de bord. Le commit Git initial créé dans chaque sandbox emploie aussi une date fixe et désactive hooks et signature globale.

## Preuves et Inspect View

Inspect fournit nativement dans chaque fichier `.eval` :

- input exact, sortie finale et statut du run ;
- identité du modèle, arguments et métadonnées de tâche ;
- événements et traces, appels du sandbox et scoring ;
- durée et usage de tokens quand le fournisseur les expose ;
- erreurs structurées et informations de retry.

Le scorer technique permet de dériver simplement, sans stockage maison :

- résultat des tests du target ;
- chemins modifiés et statut Git ;
- patch Git ;
- commit initial du workspace.

Le futur Lab devra encore associer explicitement les deux logs d'une expérience, conserver leur identité de target, produire le rapport A/B, définir la politique d'artefacts et organiser la revue humaine. Inspect ne décide pas quel prompt est « meilleur ».

Les logs produits sont compatibles avec Inspect View. Commandes vérifiées :

```powershell
uv run --project . inspect view start --log-dir logs --recursive
uv run --project . inspect view bundle --log-dir logs/isolation --output-dir logs/view-bundle --overwrite
```

Le bundle a été créé avec son `index.html`, le log et son index. Le viewer expose la tâche, les messages/événements, la sortie, le score technique, les métadonnées et les erreurs. Les logs et bundles locaux sont ignorés par Git.

## Interruption et reprise

Le test contrôlé lance un eval set composé d'un cas terminé et d'un cas interrompu. Au second appel sur le même `log_dir`, le compteur du cas terminé reste à 1 et celui du cas échoué passe de 1 à 2 : Inspect réutilise le log terminé et ne relance que le cas en échec. Une tentative interrompue au milieu d'un sample est recommencée ; elle ne reprend pas automatiquement l'état filesystem éphémère de ce conteneur.

Sous Windows, Inspect 0.3.276 affiche `socket has no attribute AF_UNIX` et désactive son control server local. Les evals, logs, eval sets et retries testés fonctionnent, mais `inspect ctl` n'est pas disponible dans cette configuration Windows native. Un runner Linux éviterait cette limite.

## Conclusion

**PARTIELLEMENT SUFFISANT**

Inspect fournit une frontière Docker vérifiable, le lancement du vrai Codex CLI via inspect-swe, des logs structurés, Inspect View et la reprise d'un eval set sans rejouer les tâches terminées. La preuve d'inférence réelle reste toutefois incomplète dans cet environnement faute de credential fournisseur, et le control server n'est pas utilisable sous Windows natif.

Le futur Lab doit conserver : la préparation minimale et l'identité des targets, l'orchestration et l'association BASELINE/AVEC PROMPT, l'extraction normalisée des états Git et des artefacts, la politique de reprise d'un sample interrompu, le rapport factuel et la revue humaine. Il ne doit pas reconstruire le sandbox, le format de log ou le viewer fournis par Inspect.

## Références publiques consultées

- [inspect-swe — Codex CLI](https://meridianlabs-ai.github.io/inspect_swe/codex_cli.html)
- [Inspect AI — Sandboxing](https://inspect.aisi.org.uk/sandboxing.html)
- [Inspect AI — Datasets (`Sample.files`)](https://inspect.aisi.org.uk/datasets.html)
- [Inspect AI — Eval Sets](https://inspect.aisi.org.uk/eval-sets.html)
- [Inspect AI — Eval Logs](https://inspect.aisi.org.uk/eval-logs.html)
- [Inspect AI — Log Viewer](https://inspect.aisi.org.uk/log-viewer.html)
