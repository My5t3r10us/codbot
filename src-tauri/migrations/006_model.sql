-- Modèle et effort de raisonnement retenus pour le run (repris tels quels à la reprise).
-- NULL : modèle par défaut de Claude Code.
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN effort TEXT;
-- Choix forcé au lancement pour un élément de la file (JSON { model, effort }). NULL : choix automatique au démarrage.
ALTER TABLE queue ADD COLUMN model_choice TEXT;
