# Codbot : spécification produit

> Application de bureau (.exe) qui relie les tâches ClickUp aux agents Claude Code :
> sélectionner des tâches, leur assigner un agent, suivre leur statut jusqu'au push GitHub,
> et faire tourner une file de tâches sans surveillance.

| | |
|---|---|
| Statut | Brouillon v1, validé en brainstorm le 2026-10-29 |
| Auteur | b.moine |
| Utilisateur cible | Usage personnel, installé sur plusieurs PC |

---

## 1. Problème

Les tâches vivent dans ClickUp, le travail se fait dans des sessions Claude Code, et rien ne relie les deux.
Aujourd'hui, il faut :
- rédiger à la main le brief de chaque agent à partir de la tâche ;
- repérer quelle session attend une réponse ;
- reporter le résultat (statut, branche, commit) dans ClickUp ;
- lancer la tâche suivante soi-même quand la précédente est finie.

Le goulot, c'est l'attention de l'utilisateur, pas les tâches.

## 2. Objectifs et non-objectifs

**Objectifs**
- Voir ses tâches ClickUp et lancer un agent dessus en quelques clics.
- Lier un agent à **une ou plusieurs** tâches (sous-tâches, tâches sur le même sujet).
- Faire avancer le statut ClickUp à partir d'**événements vérifiables** (session, commit, push, merge), en mode automatique ou manuel.
- Gérer git correctement : commit direct sur `main` pour une petite feature, branche + PR sinon.
- Enchaîner une **file d'attente** (ex. 10 tâches) pendant plusieurs heures sans intervention.
- Utiliser **l'abonnement Claude** (pas d'API payante) avec ses skills, rules, `CLAUDE.md` et MCP.
- S'installer sur **plusieurs PC**.

**Non-objectifs**
- Refaire ClickUp : pas de création ou d'édition avancée de tâches, pas de vues Gantt ou tableaux. ClickUp reste la source de vérité.
- Usage multi-utilisateurs, comptes ou serveur central.
- Appels à l'API Anthropic.

## 3. Concepts

| Concept | Définition |
|---|---|
| **Tâche** | Tâche ClickUp (ID `CU-xxxx`), éventuellement avec sous-tâches. |
| **Run** | Une exécution d'agent liée à 1..N tâches, sur un repo, avec un mode et une stratégie git. |
| **Mode de run** | `séparé` : 1 tâche = 1 worktree = 1 session, en parallèle. `groupé` : N tâches dans 1 worktree et 1 session. |
| **Stratégie git** | `direct-main` : commit puis push sur `main`. `branche` : branche, PR, puis merge par l'utilisateur. |
| **Session** | Processus `claude` piloté par l'app, identifié par son `session_id` (pour pouvoir le reprendre). |
| **File** | Liste ordonnée de runs en attente, consommée selon la limite de concurrence. |

## 4. Parcours principaux

**P1. Lancer un agent sur une tâche**
1. Tâches → je filtre (liste, statut, tag) → je coche 1..N tâches.
2. « Assigner un agent » → l'app propose le repo (via la correspondance liste → repo), le mode (`séparé` / `groupé`) et la stratégie git (par défaut, voir §5.5).
3. Le brief est prévisualisé (titre, description, sous-tâches, checklist, pièces jointes texte) et peut être modifié.
4. « Lancer maintenant » ou « Ajouter à la file ».

**P2. Une nuit de travail**
1. J'ajoute 10 runs à la file, j'active le mode **sans surveillance**, je laisse le PC allumé.
2. L'app enchaîne les runs (2 à 3 en parallèle au maximum), met la file en pause sur une limite d'usage et reprend après la réinitialisation, et marque « Bloqué » les tâches qui posent une question.
3. Au retour : **rapport** « 7 terminées, 2 en revue, 1 bloquée », avec liens et questions en attente.

**P3. Répondre à un agent**
Un agent pose une question ou demande une permission → notification → je réponds **dans l'app** → la session reprend.

## 5. Fonctionnalités

### 5.1 Vue des tâches ClickUp
- Arborescence espace / dossier / liste, filtres (statut, assigné à moi, tag, échéance), recherche.
- Pour chaque tâche : statut, sous-tâches, run actif éventuel (badge agent), dernier événement.
- Rafraîchissement périodique (ex. 60 s) et à la demande.

### 5.2 Assignation d'un agent (1..N tâches)
- Sélection multiple, avec sélection automatique des sous-tâches quand on coche une tâche parente (désactivable).
- **Mode `séparé`** : un run, un worktree et une session par tâche.
- **Mode `groupé`** : un worktree et une session. Le brief contient toutes les tâches, avec la consigne de faire **un commit par tâche, ID ClickUp dans le message**.
- Un run ne porte que sur un seul repo.

### 5.3 Moteur d'agents (CLI Claude Code)
- L'app lance le CLI `claude` installé et connecté à l'abonnement, **sans clé API** :
  - non interactif, sortie en flux JSON (`-p`, `--output-format stream-json`, entrée en flux pour les réponses) ;
  - reprise d'une session avec `--resume <session_id>` ;
  - répertoire de travail = worktree du run, pour charger les `CLAUDE.md`, rules, skills, MCP et settings, globaux et du projet, exactement comme une session normale.
- Processus lancés avec le plugin `shell` de Tauri (`Command.create(...).spawn()`, sans fenêtre console) : stdout lu en flux, stdin écrit avec `child.write()` pour les réponses. Seuls `claude`, `git` et `gh` sont autorisés dans les capabilities Tauri.
- **Hooks injectés par run** via un fichier de settings temporaire (`--settings`), **sans modifier la config globale** de l'utilisateur. Les hooks (`SessionStart`, `Notification`, `PreToolUse`, `Stop`…) envoient leurs événements au serveur HTTP local du cœur Rust (voir §6).
- **Permissions routées vers l'app** : le hook `PreToolUse` interroge l'app et attend sa décision (autoriser / refuser), ce qui évite d'avoir à embarquer un serveur MCP et un runtime Node. À défaut, utiliser le protocole de contrôle du flux JSON sur stdin. Le choix est tranché au prototype M0. Réponse possible depuis l'interface.
- Journal complet par run (flux JSON et transcript lisible), consultable dans l'app.

### 5.4 Statuts : automatique ou manuel
- Réglage global `auto` / `manuel`, modifiable au lancement de chaque run.
- **Table de correspondance par liste ClickUp** (les statuts sont propres à chaque liste) :

| Événement observé | Statut cible (exemple) |
|---|---|
| Run démarré | En cours |
| Question, permission ou erreur en attente | Bloqué |
| Push d'une branche ou PR ouverte | En revue |
| Push sur `main` (direct-main) ou PR mergée | Terminé |
| Échec définitif | Bloqué |

- En mode **auto**, l'app change le statut et ajoute un **commentaire** dans la tâche (résumé, commits, lien branche ou PR).
- En mode **manuel**, l'app **propose** le changement (« L'agent a poussé : passer en *En revue* ? [Oui] »), sans rien écrire sans validation.
- En mode `groupé`, chaque tâche avance **séparément** quand un commit portant son ID est poussé.
- Le statut se fonde toujours sur des signaux git ou de session, **jamais sur la seule déclaration de l'agent**.

### 5.5 Stratégie git
Règle déterministe, l'agent ne décide pas :
- **Mode `séparé` avec plusieurs tâches, ou plusieurs runs actifs sur le même repo → `branche` obligatoire.**
- Une seule tâche, un seul run sur le repo → choix au lancement (`direct-main` / `branche`), avec une valeur par défaut dérivée d'un tag ClickUp (ex. `small` → `direct-main`).
- **`direct-main`** : worktree basé sur `origin/main`, commit, puis rebase sur `origin/main` et push. **Un seul run `direct-main` à la fois par repo.**
- **`branche`** : branche `cu/<id>-<slug>` (en mode groupé : ID de la tâche parente ou de la première tâche), push, puis PR ouverte avec `gh`. Le merge est fait par l'utilisateur, et la détection du merge fait passer la tâche à « Terminé ».
- Format de commit : `<type>: <résumé> [CU-<id>]`.
- Worktrees créés dans un dossier dédié (ex. `<repo>/../.codbot-worktrees/`) et nettoyés après le merge ou l'abandon.

### 5.6 File d'attente et concurrence
- File ordonnée (glisser-déposer), ajout depuis la vue des tâches.
- **Limite de concurrence** réglable (2 par défaut). Les runs au-delà attendent.
- Une tâche bloquée **ne bloque jamais la file** : délai d'attente dépassé → « Bloqué » → run suivant.
- **Limite d'usage de l'abonnement atteinte** → la file passe en pause jusqu'à l'heure de réinitialisation, puis reprend toute seule (un run interrompu reprend avec `--resume`).
- Respect des contraintes git du §5.5 au moment de prendre un run dans la file.
- Empêcher la mise en veille du PC tant que la file est active. Crate Rust `keepawake`, activé au démarrage de la file et relâché à la fin.

### 5.7 Mode sans surveillance
- **Liste blanche d'outils et de commandes par projet** (ex. édition de fichiers, git, tests, build). Tout le reste est refusé automatiquement.
- Délai de réponse configurable aux questions (ex. 10 min) → la tâche passe en « Bloqué » avec la question en commentaire, et la session reste reprenable.
- Pas de push en `direct-main` si les tests ou le build du projet échouent (commande de vérification définie par projet).

### 5.8 Notifications et rapport
- Notification système : question en attente, run terminé, file en pause ou reprise.
- **Rapport de file** à la fin, ou consultable à tout moment : runs terminés, en revue, bloqués, avec les questions, les liens PR et commits, et la durée.

### 5.9 Réglages
- **Communs** (exportables et importables en JSON, **sans secrets**) : correspondance des statuts par liste, mode de statut, liste blanche par projet, limite de concurrence, délais, conventions git, gabarit de brief.
- **Propres à la machine** : correspondance liste ClickUp → chemin local du repo, nom du PC.
- **Secrets** : jeton API ClickUp saisi dans l'app et stocké dans le **Gestionnaire d'identification Windows** (crate Rust `keyring`). Jamais dans un fichier en clair ni dans un repo.
- Vérification au démarrage : CLI `claude` trouvé et connecté, `git` et `gh` disponibles, jeton ClickUp valide.

### 5.10 Multi-PC
- Installation indépendante sur chaque PC avec l'**installeur NSIS** produit par `tauri build` (`codbot_x.y.z_x64-setup.exe`). Prérequis : WebView2 (inclus dans Windows 11, sinon installé par l'installeur).
- Mises à jour : plugin `updater` de Tauri. Les paquets de mise à jour sont signés avec une clé Tauri et décrits par un manifeste JSON hébergé (partage réseau, serveur statique ou release GitHub). Sans signature de code Windows, SmartScreen affiche un avertissement à la première installation.
- Une seule instance par PC (plugin `single-instance`), pour qu'une file ne tourne jamais deux fois sur la même machine.
- **Verrou dans ClickUp** : quand un PC prend une tâche, il pose un marqueur (champ personnalisé ou tag `codbot:<nom-pc>`, avec horodatage). Les autres PC ignorent les tâches verrouillées.
- Un verrou sans signe de vie depuis un délai configurable est considéré comme périmé et peut être repris manuellement.

## 6. Architecture technique

```
┌────────────────────────── Codbot (.exe Tauri v2) ─────────────────────────┐
│  Interface TypeScript (WebView2, template vanilla-ts)                     │
│     Tâches · Runs · File · Conversation agent · Rapport · Réglages        │
│   ├─ Client ClickUp (plugin http, REST v2, jeton personnel)               │
│   ├─ Orchestrateur : file, concurrence, verrous, machine à états          │
│   ├─ Superviseur de sessions : plugin shell (`claude` stream-json)        │
│   ├─ Git : plugin shell (`git` worktrees, push) · `gh` pour PR et merge   │
│   └─ Stockage : plugin sql (SQLite : runs, événements, file)              │
│                      │ invoke() / événements Tauri                        │
│  Cœur Rust (src-tauri, volontairement mince)                              │
│   ├─ Serveur hooks : HTTP sur 127.0.0.1, port aléatoire + jeton par run   │
│   ├─ Secrets : keyring (Gestionnaire d'identification Windows)            │
│   ├─ Anti-veille : keepawake                                              │
│   └─ Tray, notifications, single-instance, updater (plugins officiels)    │
└───────────────────────────────────────────────────────────────────────────┘
        │                     │                         │
     ClickUp API        CLI claude (abonnement)     git / GitHub
```

- **Stack** : Tauri v2, fenêtre dans WebView2, application de quelques Mo.
  - Création : `npm create tauri-app@latest codbot` (template `vanilla-ts`). Développement : `npm run tauri dev`. Build : `npm run tauri build` (installeur NSIS).
  - Prérequis sur le poste de développement : toolchain Rust (`rustup`) et Microsoft C++ Build Tools. Rien de tout ça n'est nécessaire sur les PC où l'app est seulement installée.
- **Répartition TS / Rust** : la logique métier (ClickUp, orchestrateur, superviseur, git) est en **TypeScript**, avec les plugins officiels `shell`, `http`, `sql`, `notification`, `updater` et `single-instance`. Le Rust se limite à ce qu'aucun plugin ne couvre : serveur des hooks, `keyring`, `keepawake`, plus le câblage du tray. Les événements des hooks remontent à l'interface par les événements Tauri.
- **Fiabilité sur 4 h** : la fenêtre se cache dans le tray au lieu de se fermer, et la limitation des webviews en arrière-plan est désactivée (option `backgroundThrottling` de la fenêtre), pour que l'orchestrateur TypeScript continue de tourner. À valider en M0 (voir H5).
- **Seul port ouvert** : le serveur HTTP des hooks Claude Code, en écoute sur `127.0.0.1` uniquement, port aléatoire, jeton par run.
- **Persistance** : SQLite via le plugin `sql` (runs, événements, file, état des verrous). Autorisé par la règle des bases de dev, car l'app est local-first.
- **Détection du merge des PR** : interrogation périodique avec `gh pr view`.

## 7. Modèle de données (simplifié)

- `Run { id, repo, mode, git_strategy, task_ids[], branch, worktree_path, session_id, state, created_at, started_at, ended_at }`
- `RunEvent { run_id, type, payload, at }`, les types incluant `started`, `question`, `permission`, `commit`, `pushed`, `pr_opened`, `pr_merged`, `rate_limited`, `failed`, `done`.
- `QueueItem { position, run_id }`
- `StatusMapping { clickup_list_id, event_type, clickup_status }`
- `ProjectConfig { clickup_list_id, repo_path (machine), verify_command, allowlist[] }`

États d'un run : `en_file → démarrage → en_cours ⇄ en_attente_réponse → poussé → en_revue → terminé`, avec `bloqué`, `pause_limite` et `échec` comme états de sortie ou d'attente.

## 8. Exigences non fonctionnelles
- Ne jamais modifier la configuration Claude globale de l'utilisateur. Hooks et settings sont injectés par run.
- Robustesse sur 4 h ou plus : reprise après un crash de l'app (la file et les runs sont relus depuis SQLite, les sessions reprises avec `--resume`).
- Aucun secret dans les logs, les commentaires ClickUp ou les commits.
- Serveur local en écoute sur `127.0.0.1` uniquement, avec un jeton par run.

## 9. Risques et hypothèses à valider

| # | Hypothèse | Risque si fausse | Validation |
|---|---|---|---|
| **H1 (la plus risquée)** | Le CLI `claude` en mode non interactif, piloté par une app, avec l'abonnement, permet de détecter les questions et permissions, de répondre puis de reprendre de façon fiable. | Le mode sans surveillance et les réponses dans l'app ne tiennent pas. | **Prototype technique en premier** (voir §10, M0). |
| H2 | La limite d'usage est détectable dans le flux, avec l'heure de réinitialisation. | La file échoue au lieu de se mettre en pause. | Prototype M0 : forcer une limite. |
| H3 | Les agents respectent la convention « un commit par tâche, ID dans le message » en mode groupé. | Les statuts par tâche sont faux en mode groupé. | Vérifier les commits côté app et alerter si un ID manque. |
| H4 | Les conditions de l'abonnement autorisent cet usage personnel automatisé. | Usage non conforme. | Relire les conditions d'utilisation avant M2. |
| H5 | L'orchestrateur en TypeScript continue de tourner normalement pendant 4 h, fenêtre cachée dans le tray. | Timers ralentis ou suspendus, file figée la nuit. | Prototype M0 : run de longue durée, fenêtre cachée. Repli : déplacer l'orchestrateur et le superviseur dans le cœur Rust. |

Risque d'usage : les agents en parallèle consomment la même enveloppe que les sessions normales de l'utilisateur. La concurrence par défaut reste basse (2), et l'usage restant doit être visible.

## 10. Jalons

- **M0. Prototype moteur (quelques jours)** : une app Tauri minimale sous Windows qui lance `claude` sur un repo de test, capte le flux et les hooks, répond à une permission, reprend avec `--resume` et détecte une limite. Elle tourne aussi une longue durée fenêtre cachée, avec l'anti-veille actif. *Critère de passage : H1, H2 et H5 validées.*
- **M0 : fait le 2026-10-29** (voir [m0/README.md](m0/README.md)). H1 validée ; H5 (veille) et H2 (limite) restent à observer.
- **M1 : validé de bout en bout le 2026-10-29** sur `site_test_cbm` (run → commit `[CU-…]` → push sur `master` → statut « terminer » et commentaire ClickUp). Le flux contient un `rate_limit_event` à chaque requête, avec `status` et `resetsAt` : la pause sur limite (H2) pourra s'appuyer dessus. Code dans [app/](app/README.md).
- **M1. MVP** : vue ClickUp, run sur une tâche, stratégie `direct-main`, statuts auto et manuel avec correspondance, commentaires ClickUp, réglages et jeton.
- **M2 : validé le 2026-10-29** sur `site_test_cbm` (branche `cu/…`, PR #1 ouverte par `gh`, tâche « a revoir », merge détecté en moins d'une minute, tâche « terminer », worktree et branche locale supprimés). Abandonner un run remet désormais le statut qu'avait chaque tâche au lancement (sauf les tâches déjà terminées).
- **M2. Multi-tâches et git** : modes séparé et groupé, worktrees, stratégie `branche` + PR + détection du merge.
- **M3 : codé le 2026-10-29** (liste blanche testée unitairement ; file, délai de réponse et pause sur limite à tester en réel).
- **M3. File sans surveillance** : file, concurrence, liste blanche, délais, pause sur limite, rapport, anti-veille.
- **M4 : codé le 2026-10-29** : verrou par tag `codbot-<pc>`, export / import des réglages, diagnostic, instance unique, installeur NSIS. Updater ajouté ensuite : releases GitHub de `My5t3r10us/codbot`, v0.1.0 publiée le 2026-10-29.
- **M4. Multi-PC et finitions** : verrous ClickUp, export et import des réglages, installeur, reprise après crash.

## 11. Questions ouvertes
1. ~~Hébergement des mises à jour~~ : tranché, releases GitHub publiques de `My5t3r10us/codbot`, paquets signés (clé privée dans Infisical).
2. ~~Le marqueur de verrou multi-PC~~ : tranché en M4, tag `codbot-<pc>` (aucune configuration ClickUp ; l'API publique ne permet pas de créer un champ personnalisé). Un verrou périmé se libère à la main.
3. Faut-il aussi un mode « session interactive » qui ouvre le run dans Claude Code desktop pour reprendre la main ?
4. Que faire d'un run `direct-main` dont le rebase échoue en conflit : basculer automatiquement sur une branche, ou marquer « Bloqué » ?
