import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Persisted candle cache (Task #432) ───────────────────────────────────────
//
// A durable, append/upsert store for OHLCV bars so every market/timeframe can
// accumulate DEEP, scrollable history instead of resetting to a shallow
// in-memory window on every request. This is MARKET-DATA / TELEMETRY ONLY — it
// never touches execution, the 16-gate live pipeline, `arx_live_*` tables,
// balances, or fills.
//
// KEYING: a bar is uniquely identified by (symbol, timeframe, source, barTime).
//   - `symbol`    — normalized uppercase ARX/display symbol (e.g. "EURUSD").
//   - `timeframe` — canonical ARX timeframe ("M1","M5","M15","M30","H1","H4","D1").
//   - `source`    — the provider that produced the bar ("mt5_broker", "deriv",
//                   "assistant_real:<name>"). Provenance is preserved so a chart
//                   read serves ONE coherent source and never silently mixes,
//                   e.g., synthetic-scaled Deriv bars with broker-native bars.
//   - `barTime`   — the bar's OPEN time (timezone-aware), the canonical instant.
//
// PRECISION: OHLCV are stored as double precision (float8). float4/`real` loses
// significant digits for forex (1.092312…), so we never downcast price data.
export const marketCandlesTable = pgTable(
  "market_candles",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    source: text("source").notNull(),
    // Bridge/connection that produced the bar (R4 slice 2). NULLABLE:
    //   - non-broker sources ("deriv", "assistant_real:*") have no bridge, and
    //   - rows written before this column landed are honestly unattributed.
    // TRANSITIONAL: this column is NOT yet part of the unique key below, so the
    // "mt5_broker" mirror still holds ONE row per (symbol,timeframe,barTime) —
    // a second bridge writing the same bar overwrites it (last write wins, now
    // ATTRIBUTED to the overwriting bridge instead of silently mislabeled).
    // Widening the unique key to include this column requires a dedupe +
    // backfill migration and a bridge-scoped read path — a follow-up slice.
    // Cross-account isolation is enforced today by the bridge-scoped
    // `broker_candles` system of record and the bridge-partitioned in-memory
    // provider; this mirror is a read cache.
    bridgeConnectionId: integer("bridge_connection_id"),
    barTime: timestamp("bar_time", { withTimezone: true }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Dedupe key: the same bar (one source) can exist only once. Upserts target
    // this constraint so re-fetching a window updates OHLCV in place rather than
    // inserting duplicates.
    uniq: uniqueIndex("market_candles_sym_tf_src_time_uq").on(
      t.symbol,
      t.timeframe,
      t.source,
      t.barTime,
    ),
    // Read path: paginated `before`-cursor reads scan by
    // (symbol, timeframe, source) ordered on barTime.
    readIdx: index("market_candles_read_idx").on(
      t.symbol,
      t.timeframe,
      t.source,
      t.barTime,
    ),
  }),
);

export type MarketCandle = typeof marketCandlesTable.$inferSelect;
export type NewMarketCandle = typeof marketCandlesTable.$inferInsert;
