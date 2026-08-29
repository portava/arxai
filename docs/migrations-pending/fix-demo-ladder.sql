-- branch fix/demo-ladder — honest paper/demo fill simulation + reachable ladder.
-- Additive only. Apply via raw psql (drizzle-kit push is broken against the dev
-- DB — pre-existing broker_hub drift). Idempotent: IF NOT EXISTS everywhere.
--
-- ══ DEPLOY ORDER — SQL FIRST, THEN CODE. THIS IS A HARD CONSTRAINT. ══════════
-- These columns are additive to the SCHEMA but NOT optional to the CODE. The
-- branch adds `simulated = false` predicates to the EXISTING realised-money
-- readers, so shipping the code against a database that has not run this file
-- does not merely disable the new paper/demo feature — it raises Postgres 42703
-- (column "simulated" does not exist) on the LIVE money path and takes out
-- mission realised stats, the whole protection refresh, and the promotion gate.
--
-- Readers that HARD-REQUIRE these columns (each throws 42703 without them):
--   * missionExitManager.resolveMissionRealisedStats      (`simulated = false`)
--   * missionExitManager.refreshMissionProtection         (`simulated = false`)
--   * missionDriver.manageOpenExits                       (`simulated = false`)
--   * missionExecutionModeService.readRealisedForBasis    (both column families)
--   * missionPromotionService.readClosedDrafts            (`simulated = false`)
--   * missionSimulatedFills.readSimulatedClosedDrafts     (`simulated`, sim_*)
--
-- Rollback is therefore also ordered: revert the CODE first, then (optionally)
-- drop the columns. Dropping the columns under running code breaks live
-- missions. The columns are harmless to a database whose code predates them.
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY: a paper/demo mission never contacts a broker, so it could never produce
-- the broker-reconciled outcome columns (pnl / r_multiple / closed_at /
-- captured_profit / missed_profit) — its drafts froze at `executed` forever and
-- the promotion gate's demo_performance requirement had no producible source.
--
-- THE SEPARATION IS STRUCTURAL. A simulated outcome lands ONLY in this new
-- column family; a simulated row's broker-reconciled columns stay NULL forever.
-- Every consumer of realised money keys off closed_at/pnl, so a simulated
-- outcome cannot reach a live realised total or an economic posting even if a
-- future caller forgets to filter on `simulated`.

ALTER TABLE mission_trade_drafts
  ADD COLUMN IF NOT EXISTS simulated        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sim_entry_price  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sim_exit_price   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sim_pnl          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sim_r_multiple   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sim_mfe          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sim_mae          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sim_exit_reason  TEXT,
  ADD COLUMN IF NOT EXISTS sim_json         JSONB,
  ADD COLUMN IF NOT EXISTS sim_opened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sim_closed_at    TIMESTAMPTZ;

-- The simulated-exit worker sweeps open simulated positions per mission.
CREATE INDEX IF NOT EXISTS mission_trade_drafts_sim_open_idx
  ON mission_trade_drafts (mission_id, user_id)
  WHERE simulated = TRUE AND sim_closed_at IS NULL;

-- Promotion / progress read the closed simulated evidence per mission.
CREATE INDEX IF NOT EXISTS mission_trade_drafts_sim_closed_idx
  ON mission_trade_drafts (mission_id, user_id, sim_closed_at)
  WHERE simulated = TRUE;
