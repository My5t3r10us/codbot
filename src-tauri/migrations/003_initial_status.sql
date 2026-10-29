-- Statut ClickUp de chaque tâche au lancement du run, remis en place si le run est abandonné.
-- JSON : { "<task_id>": "<statut>" }
ALTER TABLE runs ADD COLUMN task_initial_status TEXT NOT NULL DEFAULT '{}';
