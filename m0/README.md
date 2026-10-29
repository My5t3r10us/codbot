# Codbot M0 : prototype du moteur d'agents

Prototype jetable qui valide les hypothèses H1, H2 et H5 de [SPEC.md](../SPEC.md) avant de construire l'app.

## Lancer

```bash
npm install
npm run tauri dev
```

Prérequis : Rust (MSVC), Node, le CLI `claude` **connecté** (`claude` puis `/login`), `git`, `curl`.
Le repo de test par défaut est `C:\Code\codbot\m0-sandbox`.

## Ce que fait le prototype

- Lance `claude -p` en `stream-json` (entrée et sortie) via le plugin `shell`, avec un fichier
  `--settings` propre au run qui injecte des hooks (`SessionStart`, `PreToolUse`, `PostToolUse`,
  `Notification`, `Stop`). La config globale n'est pas modifiée.
- Les hooks appellent `curl` vers un serveur HTTP local du cœur Rust (`127.0.0.1`, port aléatoire, jeton).
- Deux routages des permissions, au choix dans l'interface :
  - **Hook** : `PreToolUse` reste bloqué jusqu'à la décision prise dans l'app (`--permission-prompts none`).
  - **stdio** : le CLI émet `control_request` / `can_use_tool`, l'app répond `control_response` sur stdin
    (`--permission-prompts host`).
- Reprise d'une session arrêtée avec `--resume <session_id>`.
- Détection de limite d'usage dans le flux (`rate_limit_event`, résultat en erreur).
- Vérifications système : coffre Windows (`keyring`), notification, anti-veille (`keepawake`),
  battement d'une seconde pour mesurer la limitation de la webview fenêtre cachée (fermer la fenêtre
  la cache dans le tray ; « Quitter » depuis le tray).

## État au 2026-10-29

Vérifié :
- Le cœur Rust et l'interface compilent ; `npm run tauri dev` ouvre la fenêtre « Codbot M0 ».
- Le serveur des hooks écoute sur `127.0.0.1` uniquement (port aléatoire) et refuse une requête sans le bon jeton (HTTP 403).

Premier passage des scénarios (18:42 à 18:45, d'après les transcripts de `m0-sandbox`) :
- **S1 validé** : abonnement Team (`claude auth status` → `claude.ai`, sans clé API). Les transcripts
  contiennent la liste des skills de l'utilisateur et ses serveurs MCP.
- **S2 validé (routage Hook)** : les deux `PreToolUse` (Write, Bash) ont attendu la décision prise
  dans l'app (5 à 6 s) puis renvoyé `permissionDecision: allow`. Les hooks `SessionStart`,
  `PostToolUse` et `Stop` arrivent au serveur. `hello.txt` a été créé.
- **S3 validé (routage stdio)**, d'après l'utilisateur : la carte de permission est apparue et la
  réponse a été prise en compte (cohérent avec `git status` exécuté 5 s après sa demande).
- **S5 validé**, d'après l'utilisateur : coffre Windows, notification et anti-veille à « OK ».
- **S4 validé** (second passage, 18:55 à 18:59) : session arrêtée après son tour, puis relancée
  avec `--resume`. Le hook `SessionStart:resume` arrive, la suite s'écrit dans le **même**
  transcript (même `session_id`), et l'agent résume correctement ce qu'il avait fait (lecture de
  `hello.txt`, `git status`). Le premier passage n'avait pas utilisé « Reprendre ».
- **S6 non fait** : il demande au moins 30 min fenêtre cachée.

## Scénarios de validation

| # | Scénario | Attendu | Résultat |
|---|---|---|---|
| S1 | Démarrer, regarder la ligne `init` | Modèle, outils, skills et MCP de l'utilisateur chargés, sans clé API | |
| S2 | Routage **Hook** : l'agent veut écrire `hello.txt` | Permission affichée, « Autoriser » → fichier créé ; « Refuser » → l'agent s'adapte | |
| S3 | Routage **stdio** : même scénario | Idem via `control_request` | |
| S4 | Arrêter, puis « Reprendre » avec un nouveau message | L'agent se souvient du contexte | |
| S5 | Coffre, notification, anti-veille | Trois lignes « OK » | |
| S6 | Fenêtre cachée 4 h (ou 30 min pour un premier signal), anti-veille actif | Écart max proche de 1000 ms, ticks cachés qui augmentent | |
| S7 | Limite d'usage | Ligne « LIMITE D'USAGE » avec l'heure de réinitialisation | Observé seulement si la limite est atteinte |
