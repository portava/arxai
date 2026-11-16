-- Additive, idempotent. Versioned calibration fits (append-only).
-- Apply BEFORE deploying the calibration engine: the refit worker and the
-- calibration routes read and write this table. No existing row is touched.
CREATE TABLE IF NOT EXISTS calibration_fits (
  id              serial PRIMARY KEY,
  fit_key         text NOT NULL,
  version         integer NOT NULL,
  source          text NOT NULL,
  strategy        text NOT NULL,
  symbol          text NOT NULL,
  timeframe       text NOT NULL,
  method          text NOT NULL,
  status          text NOT NULL,
  model           text NOT NULL,
  n               integer NOT NULL,
  wins            integer NOT NULL,
  base_rate       real,
  brier           real,
  brier_baseline  real,
  brier_raw       real,
  edge_detected   boolean NOT NULL DEFAULT false,
  fit             jsonb NOT NULL,
  data_from       timestamptz,
  data_to         timestamptz,
  fitted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calibration_fits_key_version_ux ON calibration_fits (fit_key, version);
CREATE INDEX IF NOT EXISTS calibration_fits_key_idx ON calibration_fits (fit_key);
CREATE INDEX IF NOT EXISTS calibration_fits_strategy_idx ON calibration_fits (strategy);
-- Rollback: roll back application code first; then (optional)
--   DROP TABLE IF EXISTS calibration_fits;
