-- Additive, idempotent. Evidence provenance on calibration fits.
-- Every fit records the components behind its N (live source, or a replay on
-- a committed real-history fixture with its dataset hash and file sha256) and
-- the live-vs-replay precedence rule applied. Existing rows keep NULL
-- (they predate provenance and read as "basis: none recorded").
ALTER TABLE calibration_fits ADD COLUMN IF NOT EXISTS provenance jsonb;
