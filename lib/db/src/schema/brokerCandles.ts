import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  doublePrecision,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Broker-native candle store (Task #469, Phase A) ──────────────────────────
//
// The CANONICAL, durable, bridge-scoped store for OHLC bars streamed by a
// per-user MT5 EA (CopyRates). Unlike `market_candles` — which is keyed by the
// generic (symbol, timeframe, source) and is provider-agnostic — this table
// preserves FULL broker provenance so a bar can always be traced back to the
// exact bridge/account, broker Market-Watch symbol, and terminal that produced
// it. It does NOT replace `market_candles`: the accepted CLOSED bars are still
// mirrored into that cache (source "mt5_broker") so the existing chart/scanner
// router slot keeps reading broker-native bars. This table is the durable
// system of record; `market_candles` is the read-path projection.
//
// KEYING: a bar is uniquely identified by
//   (bridge_connection_id, broker_symbol, timeframe, open_time_utc).
//   - `bridgeConnectionId` — the mt5_connection.id (bridge/account scope). Two
//     different bridges/accounts may legitimately hold the same broker_symbol +
//     timeframe + open_time bar with slightly different prices (different LPs),
//     so the bridge MUST be part of the key — never collapse across accounts.
//   - `brokerSymbol`       — the EXACT broker Market-Watch name (case-sensitive
//     on MT5), e.g. "EURUSD", "Volatility 75 Index", "XAUUSD.r".
//   - `timeframe`          — pinned to the candle-contract timeframe enum: the
//     full 21 MT5 set (M1,M2,M3,M4,M5,M6,M10,M12,M15,M20,M30,H1,H2,H3,H4,H6,H8,
//     H12,D1,W1,MN1). Stored as plain text — no DB enum/migration.
//   - `openTimeUtc`        — the bar's OPEN time in UTC, the canonical instant.
//
// CLOSED-BAR FINALIZATION: `isClosedBar` distinguishes a still-forming newest
// bar from a finalized one. A forming bar may be updated in place; once it is
// finalized (isClosedBar=true) its OHLC is immutable — a later CONFLICTING
// closed bar for the same key is REJECTED (qualityReason "closed_bar_conflict")
// rather than silently overwriting trustworthy history.
//
// PRECISION: OHLC + volumes are double precision (float8). float4/`real` loses
// significant digits for forex (1.092312…), so price data is never downcast.
//
// SAFETY SCOPE: MARKET-DATA / TELEMETRY ONLY. This table never touches
// execution, the 16-gate live pipeline, `arx_live_*` tables, balances, margin,
// or fills. Per-user isolation is preserved via `userId` (every read is scoped
// to the bridge owner).
export const brokerCandlesTable = pgTable(
  "broker_candles",
  {
    id: serial("id").primaryKey(),
    // Bridge owner — every read is scoped to this user (per-user isolation).
    userId: integer("user_id").notNull(),
    // mt5_connection.id — the bridge/account that produced the bar.
    bridgeConnectionId: integer("bridge_connection_id").notNull(),
    // Broker account number (provenance only; nullable until reported).
    accountNumber: text("account_number"),
    // EXACT broker Market-Watch name (case-sensitive on MT5).
    brokerSymbol: text("broker_symbol").notNull(),
    // ARX/display symbol the chart queries by (normalized uppercase).
    symbol: text("symbol").notNull(),
    // Pinned to the candle-contract timeframe enum: the full 21 MT5 set
    // (M1…M30, H1…H12, D1, W1, MN1). Stored as plain text — no DB enum/migration.
    timeframe: text("timeframe").notNull(),
    // Bar OPEN time in UTC — the canonical instant (part of the unique key).
    openTimeUtc: timestamp("open_time_utc", { withTimezone: true }).notNull(),
    // Bar CLOSE time in UTC — open + one interval (derived; nullable).
    closeTimeUtc: timestamp("close_time_utc", { withTimezone: true }),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    tickVolume: doublePrecision("tick_volume"),
    realVolume: doublePrecision("real_volume"),
    spread: doublePrecision("spread"),
    // Producer label — "mt5_ea" for EA CopyRates pushes.
    source: text("source").notNull().default("mt5_ea"),
    // EA terminal identifier (provenance only; nullable).
    terminalId: text("terminal_id"),
    // FALSE while the newest bar is still forming; TRUE once finalized.
    isClosedBar: boolean("is_closed_bar").notNull().default(true),
    // Broker server clock at push time (provenance / skew analysis; nullable).
    brokerServerTime: timestamp("broker_server_time", { withTimezone: true }),
    // "accepted" | "finalized" | "idempotent" — last accepted transition.
    qualityStatus: text("quality_status").notNull().default("accepted"),
    // Human-readable reason for the last transition (nullable).
    qualityReason: text("quality_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Dedupe / upsert key. The SAME bar (one bridge/account, one broker symbol,
    // one timeframe, one open instant) can exist only once.
    uniq: uniqueIndex("broker_candles_bridge_sym_tf_time_uq").on(
      t.bridgeConnectionId,
      t.brokerSymbol,
      t.timeframe,
      t.openTimeUtc,
    ),
    // Read path: per-user chart reads scan by (userId, symbol, timeframe)
    // ordered on openTimeUtc.
    readIdx: index("broker_candles_user_read_idx").on(
      t.userId,
      t.symbol,
      t.timeframe,
      t.openTimeUtc,
    ),
  }),
);

export type BrokerCandle = typeof brokerCandlesTable.$inferSelect;
export type NewBrokerCandle = typeof brokerCandlesTable.$inferInsert;
