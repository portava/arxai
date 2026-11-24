CREATE TABLE IF NOT EXISTS ati_shadow_runs (
  id uuid PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id integer NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL CHECK (timeframe = 'M5'),
  setup text NOT NULL,
  baseline_version text NOT NULL,
  challenger_version text NOT NULL,
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > started_at)
);

CREATE TABLE IF NOT EXISTS ati_shadow_observations (
  run_id uuid NOT NULL REFERENCES ati_shadow_runs(id) ON DELETE CASCADE,
  observation_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_identity text,
  coverage text NOT NULL CHECK (coverage IN ('OBSERVED', 'NO_OBSERVED_FEED', 'SOURCE_CHANGED')),
  setup text NOT NULL,
  baseline_outcome text NOT NULL,
  challenger_outcome text NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (run_id, observation_key),
  CHECK ((coverage = 'NO_OBSERVED_FEED') = (source_identity IS NULL))
);
