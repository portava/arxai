-- Prepared only; migration-before-use is required. No runtime auto-migration.
-- Initial research limits, NOT a tested capacity claim. Owner deletion/retention
-- policy needs review before deployment: no automatic expiry or silent purge.
CREATE TABLE IF NOT EXISTS research_experiments_v1 (
  id uuid PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  manifest_version text NOT NULL CHECK (manifest_version = 'arx-research-manifest-v1'),
  engine_version text NOT NULL CHECK (engine_version = 'arx-mid-ohlc-research-v1'),
  strategy_version text NOT NULL CHECK (strategy_version = 'close-momentum-v1'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
  strategy_hash text NOT NULL CHECK (strategy_hash ~ '^[a-f0-9]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  input_bars integer NOT NULL CHECK (input_bars BETWEEN 3 AND 10000),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 8388608),
  canonical_payload text NOT NULL,
  canonical_manifest text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (owner_id > 0),
  CHECK (payload_bytes = octet_length(canonical_payload)),
  CHECK (octet_length(canonical_manifest) BETWEEN 1 AND 4096),
  CHECK (payload_hash = encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex')),
  CHECK (manifest_hash = encode(sha256(convert_to(canonical_manifest, 'UTF8')), 'hex')),
  CHECK ((canonical_payload::jsonb @> jsonb_build_object(
    'engineVersion', engine_version, 'classification', 'diagnostic',
    'verification', 'unverified', 'pnlUnit', 'price_units_per_unit',
    'authority', jsonb_build_object('promotionEligible', false, 'brokerVerified', false, 'persistedExperiment', false),
    'inputSnapshot', jsonb_build_object('priceBasis', 'MID', 'source', jsonb_build_object('reference', dataset_id::text)),
    'configSnapshot', jsonb_build_object('strategy', jsonb_build_object('version', strategy_version)),
    'fingerprints', jsonb_build_object('input', input_hash, 'configuration', configuration_hash, 'strategy', strategy_hash, 'result', result_hash)
  ) AND jsonb_array_length(canonical_payload::jsonb #> '{inputSnapshot,bars}') = input_bars) IS TRUE),
  CHECK ((canonical_manifest::jsonb @> jsonb_build_object(
    'version', manifest_version, 'experimentId', id::text, 'ownerId', owner_id,
    'requestId', request_id::text, 'datasetId', dataset_id::text,
    'engineVersion', engine_version, 'strategyVersion', strategy_version,
    'inputHash', input_hash, 'configurationHash', configuration_hash,
    'strategyHash', strategy_hash, 'resultHash', result_hash, 'payloadHash', payload_hash,
    'inputBars', input_bars, 'payloadBytes', payload_bytes
  ) AND (canonical_manifest::jsonb ->> 'recordedAt')::timestamptz = created_at) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS research_experiments_v1_owner_request_uq
  ON research_experiments_v1(owner_id, request_id);
CREATE INDEX IF NOT EXISTS research_experiments_v1_owner_page_idx
  ON research_experiments_v1(owner_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION research_experiments_v1_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE used_count bigint; used_bytes bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'RESEARCH_READ_COMMITTED_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- Dedicated two-int namespace 'ARXR' (1095915602), not an execution lock.
  PERFORM pg_advisory_xact_lock(1095915602, NEW.owner_id);
  -- Exact retries are resolved by the server before quota checking. Let the
  -- unique index adjudicate any direct duplicate insert without consuming quota.
  IF EXISTS (SELECT 1 FROM public.research_experiments_v1
             WHERE owner_id = NEW.owner_id AND request_id = NEW.request_id) THEN
    RETURN NEW;
  END IF;
  SELECT count(*), COALESCE(sum(payload_bytes), 0) INTO used_count, used_bytes
    FROM public.research_experiments_v1 WHERE owner_id = NEW.owner_id;
  IF used_count >= 256 OR used_bytes + NEW.payload_bytes > 268435456 THEN
    RAISE EXCEPTION 'RESEARCH_OWNER_STORAGE_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS research_experiments_v1_insert_guard ON research_experiments_v1;
CREATE TRIGGER research_experiments_v1_insert_guard BEFORE INSERT ON research_experiments_v1
  FOR EACH ROW EXECUTE FUNCTION research_experiments_v1_guard_insert();

CREATE OR REPLACE FUNCTION research_experiments_v1_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RESEARCH_EVIDENCE_APPEND_ONLY' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS research_experiments_v1_no_change ON research_experiments_v1;
CREATE TRIGGER research_experiments_v1_no_change BEFORE UPDATE OR DELETE ON research_experiments_v1
  FOR EACH ROW EXECUTE FUNCTION research_experiments_v1_immutable();
DROP TRIGGER IF EXISTS research_experiments_v1_no_truncate ON research_experiments_v1;
CREATE TRIGGER research_experiments_v1_no_truncate BEFORE TRUNCATE ON research_experiments_v1
  FOR EACH STATEMENT EXECUTE FUNCTION research_experiments_v1_immutable();
-- Triggers constrain ordinary writes, not a privileged database administrator
-- able to disable triggers or rewrite both data and hashes. No WORM claim.
