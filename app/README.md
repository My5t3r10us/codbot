# Codbot (M1)

Application Tauri v2 qui relie les tâches ClickUp aux agents Claude Code. Voir [SPEC.md](../SPEC.md).

## Lancer en développement

```bash
npm install
npm run tauri dev
```

Prérequis : Rust (MSVC), Node, le CLI `claude` connecté à l'abonnement, `git`, `curl`.
Le serveur Vite écoute sur le port 1430 (le prototype M0 garde le 1420).

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

Hors M1 (jalons suivants) : plusieurs tâches par run, branches et PR (M2), file d'attente et mode
sans surveillance (M3), multi-PC et installeur (M4).
