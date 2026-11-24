ALTER TABLE ati_shadow_runs ADD COLUMN IF NOT EXISTS assumed_costs jsonb;

CREATE TABLE IF NOT EXISTS ati_shadow_outcomes (
  run_id uuid NOT NULL,
  observation_key text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  grade_version text NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (run_id, observation_key),
  FOREIGN KEY (run_id, observation_key)
    REFERENCES ati_shadow_observations (run_id, observation_key) ON DELETE CASCADE
);
