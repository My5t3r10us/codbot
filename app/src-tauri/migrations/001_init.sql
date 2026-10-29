-- Réglages simples (clé → valeur JSON) : espace de travail, mode des statuts…
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Liste ClickUp ↔ repo local (propre à la machine)
CREATE TABLE projects (
  list_id        TEXT PRIMARY KEY,
  list_name      TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  base_branch    TEXT NOT NULL DEFAULT 'main',
  verify_command TEXT
);

-- Événement de run → statut ClickUp, par liste
CREATE TABLE status_mappings (
  list_id TEXT NOT NULL,
  event   TEXT NOT NULL,
  status  TEXT NOT NULL,
  PRIMARY KEY (list_id, event)
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  task_ids      TEXT NOT NULL,          -- JSON : ["abc123", ...]
  task_names    TEXT NOT NULL,          -- JSON
  list_id       TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  worktree_path TEXT,
  base_branch   TEXT NOT NULL,
  git_strategy  TEXT NOT NULL,          -- direct-main (M1) | branche (M2)
  session_id    TEXT,
  state         TEXT NOT NULL,
  base_commit   TEXT,
  pushed_commit TEXT,
  summary       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  ended_at      TEXT
);

CREATE TABLE run_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES runs(id),
  type    TEXT NOT NULL,
  text    TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX run_events_run ON run_events(run_id);
