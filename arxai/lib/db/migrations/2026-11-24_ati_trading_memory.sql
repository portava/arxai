ALTER TABLE ati_shadow_observations ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
ALTER TABLE ati_shadow_observations ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();
ALTER TABLE ati_shadow_outcomes ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
ALTER TABLE ati_shadow_outcomes ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();

CREATE INDEX IF NOT EXISTS ati_shadow_runs_owner_agent_idx ON ati_shadow_runs (owner_id, agent_id);
