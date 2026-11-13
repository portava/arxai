-- Additive provenance only. Never infer ticks from historical numeric volume.
-- Apply before deploying code that reads/writes tick_volume_observed.
ALTER TABLE broker_candles
  ADD COLUMN IF NOT EXISTS tick_volume_observed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN broker_candles.tick_volume_observed IS
  'True only after a valid explicit native tickVolume is observed on this row. Legacy values remain unqualified until re-observed.';
