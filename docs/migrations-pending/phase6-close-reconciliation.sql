-- Phase 6 — close reconciliation.
--
-- Additive and idempotent, per the standing rule (drizzle-kit push is broken
-- on the broker_hub constraint drift; schema lands via raw psql from this
-- directory). Safe to re-run.
--
-- 1. venue_profit_usd — the venue-reported realized P/L, present ONLY on
--    RECONCILED events. Nullable: null means the venue did not state a
--    number. Never derived, never defaulted to zero.
ALTER TABLE guided_attempt_events
  ADD COLUMN IF NOT EXISTS venue_profit_usd double precision;

-- 2. At most ONE RECONCILED event per attempt, enforced by the database, not
--    by application discipline: two concurrent reconcilers cannot both close
--    the same attempt, and the loser's insert conflicts instead of writing a
--    second, contradictory settlement record.
CREATE UNIQUE INDEX IF NOT EXISTS guided_attempt_events_reconciled_uq
  ON guided_attempt_events (intent_id)
  WHERE event_type = 'RECONCILED';
