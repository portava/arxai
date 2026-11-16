-- Rollback of 2026-11-16_broker_candle_compact.sql. Safe only while
-- broker_candles still holds every bar: before the new code is deployed (after
-- that, bars received since live only in the new tables) and never after the
-- old table is dropped.
BEGIN;
DROP TABLE IF EXISTS broker_candle_compact_progress;
DROP TABLE IF EXISTS broker_candle_bars;
DROP TABLE IF EXISTS broker_candle_attrs;
DROP TABLE IF EXISTS broker_candle_series;
COMMIT;
