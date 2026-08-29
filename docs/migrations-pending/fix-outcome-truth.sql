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
--
-- ┌────────────────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDERING IS MANDATORY: THIS SQL FIRST, THEN THE CODE.               │
-- └────────────────────────────────────────────────────────────────────────────┘
-- These three columns are ADDITIVE IN THE DATABASE but NOT backward-compatible
-- in the CODE. Drizzle's `db.select()` with no projection emits an EXPLICIT
-- column list built from the model, so every bare select on
-- `arxLivePositionsTable` starts requesting these columns the moment the code
-- ships. Against a database where this file has not been applied, each one
-- fails with `42703 column "broker_close_reported_at" does not exist` — and the
-- bare selects are on hot live-position read paths, ten of them at the time of
-- writing:
--   artifacts/api-server/src/lib/live/brokerCloseObserver.ts
--   artifacts/api-server/src/lib/live/brokerAbsenceReconcileRunner.ts
--   artifacts/api-server/src/lib/missionExitManager.ts
--   artifacts/api-server/src/lib/tradeHealth/tradeHealthService.ts
--   artifacts/api-server/src/lib/scalp/scalpManageService.ts
--   artifacts/api-server/src/lib/scalp/scalpJournalService.ts
--   artifacts/api-server/src/lib/selfTrade/executionGate.ts
--   artifacts/api-server/src/lib/selfTrade/livePositionManager.ts
--   artifacts/api-server/src/lib/live/instantTrade.ts
--   artifacts/api-server/src/lib/chart/behaviorProtection.ts
-- So: apply this file to a database BEFORE deploying the branch's code to any
-- process pointed at it. Rolling back the code does not require dropping the
-- columns (older code simply ignores them); rolling back the SQL under running
-- new code does break it. There is no code-side feature flag for this — the
-- column list is emitted by the ORM, not by a branch we control.
--
-- Verify before deploying:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'arx_live_positions'
--      AND column_name IN ('broker_close_reported_at',
--                          'broker_close_price',
--                          'broker_realised_pnl');
--   -- must return all three rows.

ALTER TABLE arx_live_positions
  ADD COLUMN IF NOT EXISTS broker_close_reported_at TIMESTAMPTZ;

ALTER TABLE arx_live_positions
  ADD COLUMN IF NOT EXISTS broker_close_price DOUBLE PRECISION;

ALTER TABLE arx_live_positions
  ADD COLUMN IF NOT EXISTS broker_realised_pnl DOUBLE PRECISION;
