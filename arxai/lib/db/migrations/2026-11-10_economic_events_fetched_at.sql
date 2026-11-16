-- Additive, idempotent. Per-event fetch time for the stored economic calendar.
-- Apply BEFORE deploying: POST /economic-events/sync writes fetched_at and the
-- /economic-events reads select it (null on older rows ⇒ served as STALE).
ALTER TABLE economic_events ADD COLUMN IF NOT EXISTS fetched_at timestamp;
-- Rows from the removed mock generator are excluded by every read; they are
-- left in place (no destructive change) and can be deleted by an operator:
--   DELETE FROM economic_events WHERE source = 'mock';
