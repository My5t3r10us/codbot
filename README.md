# Codbot

Application Tauri v2 qui relie les tâches ClickUp aux agents Claude Code. Voir [SPEC.md](SPEC.md).

## Lancer en développement

```bash
npm install
npm run tauri dev
```

Prérequis : Rust (MSVC), Node, le CLI `claude` connecté à l'abonnement, `git`, `curl`.
Le serveur Vite écoute sur le port 1430.

## Premier réglage

1. **Réglages → Jeton API ClickUp** : coller le jeton personnel (ClickUp → Réglages → Apps).
   Il est stocké dans le Gestionnaire d'identification Windows (service `codbot`).
2. **Espace de travail** : choisi automatiquement s'il n'y en a qu'un.
3. **Projets** : associer une liste ClickUp à un repo local qui a un remote `origin`, et indiquer
   sa branche principale.
4. **Correspondance des statuts** : pour chaque événement, le statut ClickUp à appliquer.
5. **Mode** : automatique (Codbot change le statut et commente) ou manuel (bandeau de suggestions).

## Ce que fait le M1

- Onglet **Tâches** : tâches ouvertes des listes associées, sous-tâches sous leur parente,
  filtres (recherche, assignées à moi, terminées), bouton « Lancer un agent ».
- **Run direct-main** sur une tâche :
  1. worktree détaché sur `origin/<branche>` dans `<parent du repo>\.codbot-worktrees\` ;
  2. session `claude` en stream-json avec un brief construit depuis la tâche (description,
     sous-tâches, checklists, consignes de commit `[CU-<id>]`) ;
  3. à la fin du tour : pas de commit → « attend une réponse » ; modifications non commitées →
     une relance automatique ; commits présents → vérification optionnelle, rebase sur
     `origin/<branche>` puis push `HEAD:<branche>` ;
  4. succès → statut « Terminé » et commentaire (commits, lien GitHub, résumé), worktree supprimé ;
     conflit, vérification ratée ou erreur → « Bloqué » avec la raison.
- **Permissions** via le hook `PreToolUse` : les outils en lecture et les éditions de fichiers
  dans le worktree sont autorisés d'office ; le reste (Bash, MCP, web…) attend une décision dans
  l'onglet Runs. Sans réponse au bout de 60 s, la tâche passe en « Bloqué » et une notification part.
- Onglet **Runs** : journal persistant, réponse à l'agent, Arrêter / Reprendre (`--resume`),
  Retenter le push, Abandonner. Au redémarrage de l'app, les runs actifs deviennent « arrêtés »
  et restent reprenables.
- Un seul run direct-main actif par repo. L'anti-veille est actif tant qu'une session tourne.

## Ce qu'ajoute le M2

- **Sélection multiple** dans l'onglet Tâches (cocher une tâche coche ses sous-tâches, désactivable),
  puis « Assigner un agent » : choix du mode, de la stratégie git, et brief modifiable.
- **Modes** : *groupé* (un agent, un worktree, toutes les tâches ; un commit par tâche avec son ID)
  ou *séparé* (un agent et une branche par tâche, en parallèle).
- **Règle de stratégie** (l'agent ne décide pas) : mode séparé à plusieurs tâches, ou run déjà actif
  sur le repo → *branche* imposée. Sinon choix libre, avec *direct-main* proposé si une tâche porte
  le tag `small`, *branche* sinon.
- **Stratégie branche** : branche `cu/<id>-<titre>` (tâche parente en mode groupé), push, PR ouverte
  avec `gh` (tâches liées et résumé de l'agent). Les tâches couvertes par un commit passent en
  « revue » avec un commentaire. Un message à l'agent pendant la revue relance la session et met la
  PR à jour, sans changer les statuts.
- **Merge** : vérifié toutes les 60 s (ou à la demande). PR mergée → tâches « terminées »,
  worktree et branche locale supprimés. PR fermée sans merge → run bloqué. Sans PR (remote hors
  GitHub), le merge est détecté avec git.
- **Suivi par tâche** en mode groupé : chaque tâche n'avance que si un commit porte son ID ;
  les autres gardent leur statut, avec un avertissement dans le journal.

## Ce qu'ajoute le M3

- **Onglet File** : « Ajouter à la file » depuis la fenêtre de lancement (le mode séparé crée une
  entrée par tâche), ordre par glisser-déposer, Démarrer / Arrêter la file.
- **Concurrence** réglable (2 agents par défaut). La file respecte les règles git par repo : un
  commit direct attend que le repo soit libre, une branche attend seulement qu'aucun commit direct
  n'y tourne.
- **Délai de réponse** (10 min par défaut, runs de la file uniquement) : une question ou une
  permission sans réponse fait passer le run en « Bloqué » (question dans le commentaire ClickUp),
  le processus s'arrête et la file continue. La session reste reprenable.
- **Sans surveillance** : chaque permission est décidée par la liste blanche du projet
  (Réglages → Projets). Motifs `Bash(npm test*)` ou nom d'outil (`WebFetch`, `mcp__github__*`) ;
  une commande enchaînée n'est autorisée que si chaque partie l'est ; `git push` est toujours
  refusé. Liste vide = liste par défaut ([allowlist.ts](src/allowlist.ts)).
- **Limite d'usage** : le run passe « en pause » au lieu d'échouer, toute la file attend l'heure de
  réinitialisation donnée par le flux (30 min par défaut), puis reprend d'abord les runs en pause.
  Après un redémarrage de l'app, les runs de la file en cours sont aussi repris.
- **Anti-veille** actif tant que la file tourne. **Rapport** de la dernière file (terminés, en
  revue, bloqués avec la raison, durées, liens PR) et notification à la fin.

## Ce qu'ajoute le M4

- **Verrou multi-PC** : un PC qui prend une tâche lui pose le tag ClickUp `codbot-<nom-du-pc>`
  (créé dans l'espace au besoin) et le retire quand le run se termine ou est abandonné. Un run
  bloqué ou en revue garde le verrou. Les autres PC ne peuvent ni cocher ni lancer la tâche, et la
  file la saute jusqu'à la levée du verrou. « Libérer » (onglet Tâches) retire un verrou périmé,
  après confirmation.
- **Ce PC** (Réglages) : nom utilisé pour le verrou, par défaut le nom Windows de la machine.
- **Partage des réglages** : export / import JSON de l'espace de travail, du mode des statuts, du
  modèle, des réglages de file, des projets (liste, branche, vérification, liste blanche) et de la
  correspondance des statuts. Ni le jeton ClickUp ni les chemins des repos : un projet importé
  attend que son repo local soit renseigné sur le nouveau PC.
- **Diagnostic** au démarrage (CLI `claude` connecté, `git`, `gh` connecté, jeton ClickUp) : carte
  dans Réglages, et « Réglages ⚠ » dans la barre si quelque chose est à corriger.
- **Une seule instance** par PC (relancer l'app ramène la fenêtre existante).
- **Installeur** : `npm run tauri build` produit
  `src-tauri\target\release\bundle\nsis\Codbot_<version>_x64-setup.exe` (installation pour
  l'utilisateur courant, sans droits admin).

## Mises à jour automatiques

- L'app lit `https://github.com/My5t3r10us/codbot/releases/latest/download/latest.json` au
  démarrage (« Réglages ⬆ » si une version est disponible) et depuis la carte « Version et mises à
  jour ». Le paquet est vérifié avec la clé publique de `tauri.conf.json` avant installation.
- Publier une version :
  1. incrémenter `version` dans `src-tauri/tauri.conf.json` ;
  2. lancer, avec la clé de signature fournie par Infisical (`TAURI_SIGNING_PRIVATE_KEY`,
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` vide) :

     ```bash
     infisical run --env=dev -- npm run release -- --notes "Ce qui change"
     ```

  Le script construit l'installeur signé, écrit `latest.json` et crée la release `v<version>`.
