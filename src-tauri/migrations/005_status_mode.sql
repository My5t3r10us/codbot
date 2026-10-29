-- Mode des statuts choisi au lancement (auto | manual). NULL : réglage global.
ALTER TABLE runs ADD COLUMN status_mode TEXT;
ALTER TABLE queue ADD COLUMN status_mode TEXT;
