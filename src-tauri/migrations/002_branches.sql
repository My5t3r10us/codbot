-- M2 : stratégie « branche » (PR), modes séparé / groupé, suivi par tâche.
ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'separe';   -- separe | groupe
ALTER TABLE runs ADD COLUMN branch TEXT;
ALTER TABLE runs ADD COLUMN pr_url TEXT;
-- JSON : { "<task_id>": "started" | "review" | "done" } : dernier événement appliqué à chaque tâche
ALTER TABLE runs ADD COLUMN task_progress TEXT NOT NULL DEFAULT '{}';
