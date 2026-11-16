-- OPT-IN: apply explicitly, then register a future cohort. No cohort = no receipts.
-- Observation only. No calibration serving, model activation, or trading changes.
CREATE TABLE IF NOT EXISTS calibration_prospective_runs_v1 (
 id uuid PRIMARY KEY,
 owner_id integer NOT NULL CHECK (owner_id > 0),
 strategy text NOT NULL CHECK (strategy IN ('eleanor','scanner')),
 symbol text NOT NULL,
 timeframe text NOT NULL,
 collection_start timestamptz NOT NULL,
 collection_end timestamptz NOT NULL,
 label_deadline timestamptz NOT NULL,
 canonical_plan text NOT NULL CHECK (octet_length(canonical_plan) BETWEEN 1 AND 1048576),
 plan_hash text NOT NULL CHECK (plan_hash = encode(sha256(convert_to(canonical_plan,'UTF8')),'hex')),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Also enforce constraints when schema push created the tables first.
ALTER TABLE calibration_prospective_runs_v1 DROP CONSTRAINT IF EXISTS prospective_run_integrity_v1;
ALTER TABLE calibration_prospective_runs_v1 ADD CONSTRAINT prospective_run_integrity_v1 CHECK
 (owner_id > 0 AND strategy IN ('eleanor','scanner') AND octet_length(canonical_plan) BETWEEN 1 AND 1048576
 AND plan_hash = encode(sha256(convert_to(canonical_plan,'UTF8')),'hex'));
CREATE INDEX IF NOT EXISTS calibration_prospective_scope_idx ON calibration_prospective_runs_v1(owner_id,symbol,timeframe,collection_end);
CREATE TABLE IF NOT EXISTS calibration_prospective_receipts_v1 (
 id bigserial PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES calibration_prospective_runs_v1(id),
 outcome_id text NOT NULL,
 phase text NOT NULL CHECK (phase IN ('prediction','outcome','mutation','deletion')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS calibration_prospective_receipt_idx ON calibration_prospective_receipts_v1(run_id,outcome_id);
CREATE INDEX IF NOT EXISTS calibration_prospective_outcome_idx ON calibration_prospective_receipts_v1(outcome_id,phase,run_id);
CREATE OR REPLACE FUNCTION calibration_prospective_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Prospective evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS calibration_prospective_runs_immutable ON calibration_prospective_runs_v1;
CREATE TRIGGER calibration_prospective_runs_immutable BEFORE UPDATE OR DELETE ON calibration_prospective_runs_v1 FOR EACH ROW EXECUTE FUNCTION calibration_prospective_immutable_v1();
DROP TRIGGER IF EXISTS calibration_prospective_receipts_immutable ON calibration_prospective_receipts_v1;
CREATE TRIGGER calibration_prospective_receipts_immutable BEFORE UPDATE OR DELETE ON calibration_prospective_receipts_v1 FOR EACH ROW EXECUTE FUNCTION calibration_prospective_immutable_v1();
CREATE OR REPLACE FUNCTION calibration_prospective_register_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb;
BEGIN
 NEW.registered_at := clock_timestamp();
 p := NEW.canonical_plan::jsonb;
 IF NOT (NEW.collection_start > NEW.registered_at AND NEW.collection_end > NEW.collection_start AND NEW.label_deadline > NEW.collection_end
   AND NEW.label_deadline <= NEW.collection_start + interval '90 days') THEN RAISE EXCEPTION 'Prospective window must be in the future'; END IF;
 IF (p->>'method' = 'paired-brier-future-cohort-v1' AND (p->>'userId')::integer = NEW.owner_id
   AND p->>'strategy' = NEW.strategy AND p->>'symbol' = NEW.symbol AND p->>'timeframe' = NEW.timeframe
   AND (p->>'collectionStart')::timestamptz = NEW.collection_start AND (p->>'collectionEnd')::timestamptz = NEW.collection_end
   AND (p->>'labelDeadline')::timestamptz = NEW.label_deadline
   AND (p->>'minSample')::integer >= 100 AND (p->>'minImprovement')::numeric >= 0.005) IS DISTINCT FROM TRUE
 THEN RAISE EXCEPTION 'Prospective plan does not match registration'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('prospective:'||NEW.owner_id||':'||NEW.strategy||':'||NEW.symbol||':'||NEW.timeframe,0));
 IF EXISTS (SELECT 1 FROM calibration_prospective_runs_v1 r WHERE r.owner_id=NEW.owner_id AND r.strategy=NEW.strategy AND r.symbol=NEW.symbol AND r.timeframe=NEW.timeframe
   AND r.collection_start < NEW.label_deadline AND NEW.collection_start < r.label_deadline)
 THEN RAISE EXCEPTION 'Overlapping prospective cohort'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS calibration_prospective_register ON calibration_prospective_runs_v1;
CREATE TRIGGER calibration_prospective_register BEFORE INSERT ON calibration_prospective_runs_v1 FOR EACH ROW EXECUTE FUNCTION calibration_prospective_register_v1();
CREATE OR REPLACE FUNCTION calibration_prospective_capture_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_time_at timestamptz := clock_timestamp(); source_row jsonb; phase_name text; prediction_changed boolean;
BEGIN
 IF TG_OP = 'INSERT' THEN
   IF NEW.direction NOT IN ('BUY','SELL') THEN RETURN NEW; END IF;
   INSERT INTO calibration_prospective_receipts_v1(run_id,outcome_id,phase,observed_at,payload)
   SELECT r.id,NEW.outcome_id,'prediction',current_time_at,to_jsonb(NEW)
   FROM calibration_prospective_runs_v1 r
   WHERE r.owner_id=NEW.user_id AND r.symbol=NEW.symbol AND r.timeframe=NEW.timeframe
     AND r.collection_start <= current_time_at AND current_time_at < r.collection_end
     AND (r.strategy='eleanor' OR NEW.scanner_signal_id IS NOT NULL);
   RETURN NEW;
 END IF;
 IF TG_OP = 'DELETE' THEN source_row := to_jsonb(OLD); phase_name := 'deletion';
 ELSE
   source_row := to_jsonb(NEW);
   prediction_changed := (to_jsonb(OLD) - ARRAY['outcome_status','evidence','resolved_at','updated_at','trade_id','pnl_r','exit_reason','user_entered','no_trade_credited','timing_class','actual_slippage','actual_start_drawdown','max_favorable_excursion','max_adverse_excursion','explanation_used'])
     IS DISTINCT FROM (source_row - ARRAY['outcome_status','evidence','resolved_at','updated_at','trade_id','pnl_r','exit_reason','user_entered','no_trade_credited','timing_class','actual_slippage','actual_start_drawdown','max_favorable_excursion','max_adverse_excursion','explanation_used']);
   IF prediction_changed THEN phase_name := 'mutation';
   ELSIF (OLD.outcome_status,OLD.resolved_at,OLD.evidence,OLD.pnl_r,OLD.trade_id) IS DISTINCT FROM (NEW.outcome_status,NEW.resolved_at,NEW.evidence,NEW.pnl_r,NEW.trade_id)
     AND (NEW.outcome_status <> 'PENDING' OR OLD.outcome_status <> 'PENDING') THEN phase_name := 'outcome';
   ELSE RETURN NEW; END IF;
 END IF;
 INSERT INTO calibration_prospective_receipts_v1(run_id,outcome_id,phase,observed_at,payload)
 SELECT DISTINCT p.run_id,OLD.outcome_id,phase_name,current_time_at,source_row
 FROM calibration_prospective_receipts_v1 p JOIN calibration_prospective_runs_v1 r ON r.id=p.run_id
 WHERE p.outcome_id=OLD.outcome_id AND p.phase='prediction' AND r.owner_id=OLD.user_id;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS calibration_prospective_capture ON eleanor_signal_outcomes;
CREATE TRIGGER calibration_prospective_capture AFTER INSERT OR UPDATE OR DELETE ON eleanor_signal_outcomes FOR EACH ROW EXECUTE FUNCTION calibration_prospective_capture_v1();
CREATE TABLE IF NOT EXISTS calibration_prospective_installations_v1(id bigserial PRIMARY KEY,installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- Every installation/reinstallation starts a new evidence epoch. Existing runs
-- cannot claim uninterrupted capture across a rollback/re-enable.
INSERT INTO calibration_prospective_installations_v1 DEFAULT VALUES;
DROP TRIGGER IF EXISTS calibration_prospective_installations_immutable ON calibration_prospective_installations_v1;
CREATE TRIGGER calibration_prospective_installations_immutable BEFORE UPDATE OR DELETE ON calibration_prospective_installations_v1 FOR EACH ROW EXECUTE FUNCTION calibration_prospective_immutable_v1();
