-- M3 : file d'attente, mode sans surveillance, rapport de file.

-- Un élément = un futur run (le mode séparé est déjà éclaté en un élément par tâche).
CREATE TABLE queue (
  id         TEXT PRIMARY KEY,
  position   INTEGER NOT NULL,
  list_id    TEXT NOT NULL,
  task_ids   TEXT NOT NULL,   -- JSON
  task_names TEXT NOT NULL,   -- JSON
  mode       TEXT NOT NULL,   -- separe | groupe
  strategy   TEXT NOT NULL,   -- direct-main | branche
  brief      TEXT,            -- brief modifié à la main (sinon généré au lancement)
  added_at   TEXT NOT NULL
);

-- Une session de file = une période « file démarrée → file vide », pour le rapport.
CREATE TABLE queue_sessions (
  id         TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

ALTER TABLE runs ADD COLUMN queue_session TEXT;

-- Liste blanche du mode sans surveillance : un motif par élément, ex. "Bash(npm test*)", "WebFetch".
ALTER TABLE projects ADD COLUMN allowlist TEXT NOT NULL DEFAULT '[]';
