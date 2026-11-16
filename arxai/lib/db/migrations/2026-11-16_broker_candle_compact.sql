-- Compact broker candle storage (docs/BROKER_CANDLES_COMPACTION_PLAN.md).
-- Additive only: creates the new tables. broker_candles is not touched; rows
-- are copied by scripts/src/compactBrokerCandles.ts and the old table is
-- dropped only by a separate, owner-approved step after verification.
BEGIN;
CREATE TABLE IF NOT EXISTS broker_candle_series (
  id serial PRIMARY KEY,
  series_key text NOT NULL,
  bridge_connection_id integer NOT NULL,
  history_identity text NOT NULL,
  broker_symbol text NOT NULL,
  timeframe text NOT NULL,
  user_id integer NOT NULL,
  symbol text NOT NULL,
  account_number text,
  server_name text,
  clock_basis text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_candle_series_key_uq ON broker_candle_series (series_key);
CREATE INDEX IF NOT EXISTS broker_candle_series_native_idx ON broker_candle_series (bridge_connection_id, history_identity, broker_symbol, timeframe);
CREATE INDEX IF NOT EXISTS broker_candle_series_read_idx ON broker_candle_series (user_id, symbol, timeframe);
CREATE TABLE IF NOT EXISTS broker_candle_attrs (
  id serial PRIMARY KEY,
  attrs_key text NOT NULL,
  source text NOT NULL,
  terminal_id text,
  price_basis text,
  quality_status text NOT NULL,
  quality_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_candle_attrs_key_uq ON broker_candle_attrs (attrs_key);
CREATE TABLE IF NOT EXISTS broker_candle_bars (
  open_time_utc timestamptz NOT NULL,
  close_time_utc timestamptz,
  broker_server_time timestamptz,
  raw_open_time timestamptz,
  raw_close_time timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  open double precision NOT NULL,
  high double precision NOT NULL,
  low double precision NOT NULL,
  close double precision NOT NULL,
  tick_volume double precision,
  real_volume double precision,
  spread double precision,
  series_id integer NOT NULL REFERENCES broker_candle_series(id),
  legacy_id integer,
  attrs_id integer NOT NULL REFERENCES broker_candle_attrs(id),
  derived smallint NOT NULL DEFAULT 0,
  is_closed_bar boolean NOT NULL DEFAULT true,
  tick_volume_observed boolean NOT NULL DEFAULT false,
  CONSTRAINT broker_candle_bars_pk PRIMARY KEY (series_id, open_time_utc)
);
CREATE TABLE IF NOT EXISTS broker_candle_compact_progress (
  id integer PRIMARY KEY,
  last_id bigint NOT NULL DEFAULT 0,
  rows_copied bigint NOT NULL DEFAULT 0,
  rows_superseded bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
