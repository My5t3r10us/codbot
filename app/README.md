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

Hors M2 (jalons suivants) : file d'attente et mode sans surveillance (M3), multi-PC et installeur (M4).
