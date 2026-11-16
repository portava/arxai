-- Real-data validation evidence: append-only, hash-checked, never live-authorising.
--
-- One row = one run of scripts/src/research/realDataValidation.ts over a named,
-- hashed dataset at a named code commit. The full result is stored as canonical
-- JSON text; the database itself re-derives both sha256 digests on insert.
--
-- Idempotent and safe to apply AFTER a drizzle schema push has already created
-- the bare table: every constraint is dropped-if-exists and re-added by name, so
-- the CHECKs and triggers are always present after this file has run.
-- Prepared only; migration-before-use is required. No runtime auto-migration.
CREATE TABLE IF NOT EXISTS validation_evidence_v1 (
  id uuid PRIMARY KEY,
  run_kind text NOT NULL,
  runner_version text NOT NULL,
  dataset_source text NOT NULL,
  dataset_hash text NOT NULL,
  params_hash text NOT NULL,
  result_hash text NOT NULL,
  code_commit text NOT NULL,
  code_dirty boolean NOT NULL,
  trials integer NOT NULL,
  survivors integer NOT NULL,
  promotion_ceiling text NOT NULL,
  live_allowed boolean NOT NULL DEFAULT false,
  payload_hash text NOT NULL,
  manifest_hash text NOT NULL,
  payload_bytes integer NOT NULL,
  canonical_payload text NOT NULL,
  canonical_manifest text NOT NULL,
  created_at timestamptz NOT NULL
);

ALTER TABLE validation_evidence_v1 DROP CONSTRAINT IF EXISTS validation_evidence_v1_kind_ck;
ALTER TABLE validation_evidence_v1 ADD CONSTRAINT validation_evidence_v1_kind_ck
  CHECK (run_kind = 'real_data_validation' AND runner_version = 'arx-real-data-validation-v1');
ALTER TABLE validation_evidence_v1 DROP CONSTRAINT IF EXISTS validation_evidence_v1_hashes_ck;
ALTER TABLE validation_evidence_v1 ADD CONSTRAINT validation_evidence_v1_hashes_ck
  CHECK (dataset_hash ~ '^[a-f0-9]{64}$' AND params_hash ~ '^[a-f0-9]{64}$' AND result_hash ~ '^[a-f0-9]{64}$'
     AND payload_hash ~ '^[a-f0-9]{64}$' AND manifest_hash ~ '^[a-f0-9]{64}$' AND code_commit ~ '^[a-f0-9]{40}$');
-- The ceiling is SHADOW and live is never allowed. Not configurable.
ALTER TABLE validation_evidence_v1 DROP CONSTRAINT IF EXISTS validation_evidence_v1_never_live_ck;
ALTER TABLE validation_evidence_v1 ADD CONSTRAINT validation_evidence_v1_never_live_ck
  CHECK (live_allowed = false AND promotion_ceiling = 'SHADOW');
ALTER TABLE validation_evidence_v1 DROP CONSTRAINT IF EXISTS validation_evidence_v1_counts_ck;
ALTER TABLE validation_evidence_v1 ADD CONSTRAINT validation_evidence_v1_counts_ck
  CHECK (trials > 0 AND survivors >= 0 AND survivors <= trials
     AND payload_bytes BETWEEN 1 AND 16777216 AND payload_bytes = octet_length(canonical_payload)
     AND octet_length(canonical_manifest) BETWEEN 1 AND 8192
     AND octet_length(dataset_source) BETWEEN 1 AND 200);
ALTER TABLE validation_evidence_v1 DROP CONSTRAINT IF EXISTS validation_evidence_v1_digest_ck;
ALTER TABLE validation_evidence_v1 ADD CONSTRAINT validation_evidence_v1_digest_ck
  CHECK (payload_hash = encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex')
     AND manifest_hash = encode(sha256(convert_to(canonical_manifest, 'UTF8')), 'hex'));
-- The payload must agree with the indexed columns, and no survivor inside it may
-- claim live permission or a ceiling above SHADOW.
ALTER TABLE validation_evidence_v1 DROP CONSTRAINT IF EXISTS validation_evidence_v1_payload_ck;
ALTER TABLE validation_evidence_v1 ADD CONSTRAINT validation_evidence_v1_payload_ck
  CHECK ((canonical_payload::jsonb @> jsonb_build_object(
      'runnerVersion', runner_version, 'datasetHash', dataset_hash, 'paramsHash', params_hash, 'resultHash', result_hash)
    AND jsonb_array_length(canonical_payload::jsonb -> 'survivors') = survivors
    AND (canonical_payload::jsonb #>> '{fdr,familySize}')::int = trials
    AND NOT jsonb_path_exists(canonical_payload::jsonb,
      '$.survivors[*] ? (@.liveAllowed != false || @.promotionCeiling != "SHADOW")')
    AND canonical_manifest::jsonb @> jsonb_build_object(
      'id', id::text, 'datasetHash', dataset_hash, 'paramsHash', params_hash, 'resultHash', result_hash,
      'payloadHash', payload_hash, 'codeCommit', code_commit, 'codeDirty', code_dirty,
      'datasetSource', dataset_source, 'liveAllowed', false, 'promotionCeiling', 'SHADOW')
    AND (canonical_manifest::jsonb ->> 'recordedAt')::timestamptz = created_at) IS TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS validation_evidence_v1_identity_uq
  ON validation_evidence_v1(dataset_hash, params_hash, result_hash, code_commit, code_dirty);
CREATE INDEX IF NOT EXISTS validation_evidence_v1_page_idx
  ON validation_evidence_v1(created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION validation_evidence_v1_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VALIDATION_EVIDENCE_APPEND_ONLY' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS validation_evidence_v1_no_change ON validation_evidence_v1;
CREATE TRIGGER validation_evidence_v1_no_change BEFORE UPDATE OR DELETE ON validation_evidence_v1
  FOR EACH ROW EXECUTE FUNCTION validation_evidence_v1_immutable();
DROP TRIGGER IF EXISTS validation_evidence_v1_no_truncate ON validation_evidence_v1;
CREATE TRIGGER validation_evidence_v1_no_truncate BEFORE TRUNCATE ON validation_evidence_v1
  FOR EACH STATEMENT EXECUTE FUNCTION validation_evidence_v1_immutable();
-- Triggers constrain ordinary writes, not a privileged administrator able to
-- disable them and rewrite both data and hashes. No WORM claim is made.
