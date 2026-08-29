-- branch fix/outcome-truth — broker-REPORTED close numbers on arx_live_positions.
--
-- WHY
--   A mission trade's realised result was only ever recorded when an ARX-issued
--   CLOSE_LIVE_POSITION command filled. A position closed by its own stop-loss
--   AT THE BROKER never returned through that path, so its loss was never
--   recorded — wins in, stop-loss losses out, realised profit biased upward.
--   The broker-side close observer records those outcomes. When the broker
--   REPORTS the closed deal, these columns hold its own numbers verbatim so the
--   recorded P/L is broker truth and not something ARX derived.
--
-- HONESTY
--   These columns are NULL whenever the broker gave us nothing. ARX never
--   backfills them from the stop-loss level, the take-profit level, or the last
--   observed floating P/L; the mission outcome is then recorded UNRECONCILED
--   (pnl NULL + a typed reason) instead of guessed.
--
-- Additive only, nullable, no backfill, no default. Apply via raw psql
-- (drizzle-kit push is not used here). Idempotent: IF NOT EXISTS on every
-- statement, safe to re-run.

ALTER TABLE arx_live_positions
  ADD COLUMN IF NOT EXISTS broker_close_reported_at TIMESTAMPTZ;

ALTER TABLE arx_live_positions
  ADD COLUMN IF NOT EXISTS broker_close_price DOUBLE PRECISION;

ALTER TABLE arx_live_positions
  ADD COLUMN IF NOT EXISTS broker_realised_pnl DOUBLE PRECISION;
