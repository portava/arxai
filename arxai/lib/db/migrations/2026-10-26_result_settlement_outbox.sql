-- Apply BEFORE this application release. No historical intents are inferred.
-- Application receipt transactions fail/roll back if this table is missing.
-- The background worker remains OFF unless explicitly enabled after migration.
CREATE TABLE IF NOT EXISTS result_settlement_jobs (
  id serial PRIMARY KEY,
  command_row_id integer NOT NULL REFERENCES arx_live_commands(id),
  user_id integer NOT NULL,
  consumer text NOT NULL CHECK (consumer IN ('EXPOSURE_RESERVATION','MANUAL_CLOSE_POSITION','AGENT_CLOSE_POSITION')),
  receipt_fingerprint text NOT NULL CHECK (receipt_fingerprint ~ '^[a-f0-9]{64}$'),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','LEASED','RETRY','HELD','DONE')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  reason text,
  completed_generation integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
         (status <> 'LEASED' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (completed_generation IS NULL OR completed_generation <= generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS result_settlement_command_consumer_uq
  ON result_settlement_jobs(command_row_id, consumer);
CREATE INDEX IF NOT EXISTS result_settlement_ready_idx
  ON result_settlement_jobs(status, due_at, id);
-- HELD is never aged into DONE. No backfill or destructive rollback is included.
-- Roll back application code and retain this evidence table if necessary.
