-- Additive provenance. Never re-attest legacy rows using today's account.
BEGIN;
ALTER TABLE broker_candles ADD COLUMN IF NOT EXISTS history_identity text NOT NULL DEFAULT 'legacy';
ALTER TABLE broker_candles ADD COLUMN IF NOT EXISTS server_name text;
ALTER TABLE broker_candles ADD COLUMN IF NOT EXISTS clock_basis text;
ALTER TABLE broker_candles ADD COLUMN IF NOT EXISTS raw_open_time timestamptz;
ALTER TABLE broker_candles ADD COLUMN IF NOT EXISTS raw_close_time timestamptz;
ALTER TABLE broker_candles ADD COLUMN IF NOT EXISTS price_basis text;
ALTER TABLE broker_candle_backfill_status ADD COLUMN IF NOT EXISTS history_identity text NOT NULL DEFAULT 'legacy';
ALTER TABLE broker_candle_backfill_status ADD COLUMN IF NOT EXISTS next_before_raw timestamptz;
ALTER TABLE broker_candle_backfill_status ADD COLUMN IF NOT EXISTS boundary_raw timestamptz;
ALTER TABLE broker_candle_backfill_status ADD COLUMN IF NOT EXISTS last_history_page_at timestamptz;
ALTER TABLE broker_candle_backfill_status ADD COLUMN IF NOT EXISTS history_pages integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS broker_candles_bridge_sym_tf_time_uq;
CREATE UNIQUE INDEX broker_candles_bridge_sym_tf_time_uq ON broker_candles (bridge_connection_id,history_identity,broker_symbol,timeframe,open_time_utc);
DROP INDEX IF EXISTS broker_candle_backfill_bridge_sym_tf_uq;
CREATE UNIQUE INDEX broker_candle_backfill_bridge_sym_tf_uq ON broker_candle_backfill_status (bridge_connection_id,history_identity,broker_symbol,timeframe);
COMMIT;
