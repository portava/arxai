ALTER TABLE ati_shadow_runs ADD COLUMN IF NOT EXISTS research_source text;
ALTER TABLE ati_shadow_runs ADD COLUMN IF NOT EXISTS research_mode text;

CREATE TABLE IF NOT EXISTS ati_research_studies (
  run_id uuid PRIMARY KEY REFERENCES ati_shadow_runs(id) ON DELETE CASCADE,
  owner_id integer NOT NULL,
  agent_id integer NOT NULL,
  request_id uuid NOT NULL,
  registration text NOT NULL,
  registration_hash text NOT NULL CHECK (registration_hash ~ '^[0-9a-f]{64}$'),
  registered_at timestamptz NOT NULL,
  CONSTRAINT ati_research_owner_request UNIQUE (owner_id, agent_id, request_id)
);

CREATE TABLE IF NOT EXISTS ati_research_seals (
  run_id uuid PRIMARY KEY REFERENCES ati_research_studies(run_id) ON DELETE CASCADE,
  dataset text NOT NULL,
  dataset_hash text NOT NULL CHECK (dataset_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('INSUFFICIENT_EVIDENCE', 'REJECTED', 'FORWARD_REVIEW_REQUIRED')),
  sealed_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION ati_research_preserve_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Keep the parent ownership cascade available for account-data deletion.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ATI research evidence is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ati_research_studies_no_change ON ati_research_studies;
CREATE TRIGGER ati_research_studies_no_change BEFORE UPDATE OR DELETE ON ati_research_studies
FOR EACH ROW EXECUTE FUNCTION ati_research_preserve_evidence();
DROP TRIGGER IF EXISTS ati_research_seals_no_change ON ati_research_seals;
CREATE TRIGGER ati_research_seals_no_change BEFORE UPDATE OR DELETE ON ati_research_seals
FOR EACH ROW EXECUTE FUNCTION ati_research_preserve_evidence();
DROP TRIGGER IF EXISTS ati_research_studies_no_truncate ON ati_research_studies;
CREATE TRIGGER ati_research_studies_no_truncate BEFORE TRUNCATE ON ati_research_studies
FOR EACH STATEMENT EXECUTE FUNCTION ati_research_preserve_evidence();
DROP TRIGGER IF EXISTS ati_research_seals_no_truncate ON ati_research_seals;
CREATE TRIGGER ati_research_seals_no_truncate BEFORE TRUNCATE ON ati_research_seals
FOR EACH STATEMENT EXECUTE FUNCTION ati_research_preserve_evidence();

CREATE OR REPLACE FUNCTION ati_research_preserve_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.measured_cost_profile IS NULL AND NEW.measured_cost_profile IS NOT NULL
     AND (to_jsonb(OLD) - 'measured_cost_profile') = (to_jsonb(NEW) - 'measured_cost_profile') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ATI research run definition is immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ati_research_run_no_change ON ati_shadow_runs;
CREATE TRIGGER ati_research_run_no_change BEFORE UPDATE OR DELETE ON ati_shadow_runs
FOR EACH ROW WHEN (OLD.research_source IS NOT NULL) EXECUTE FUNCTION ati_research_preserve_run();
