-- Additive, idempotent. Apply BEFORE deploying the broker clock offset
-- persistence change (the Drizzle mt5_connection table selects these columns).
-- Persists each bridge's last measured broker clock offset (broker − UTC, ms)
-- so a server restart does not reset it to unknown. NULLs mean "never
-- measured"; no historical row is rewritten or backfilled.
ALTER TABLE mt5_connection ADD COLUMN IF NOT EXISTS broker_clock_offset_ms integer;
ALTER TABLE mt5_connection ADD COLUMN IF NOT EXISTS broker_clock_offset_measured_at timestamp;
-- Rollback: roll back application code first; then (optional)
--   ALTER TABLE mt5_connection DROP COLUMN IF EXISTS broker_clock_offset_measured_at;
--   ALTER TABLE mt5_connection DROP COLUMN IF EXISTS broker_clock_offset_ms;
