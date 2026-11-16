import {
  pgTable,
  serial,
  integer,
  bigint,
  smallint,
  text,
  boolean,
  doublePrecision,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// Compact storage for the durable broker candle store (replaces the wide
// `broker_candles` rows; see docs/BROKER_CANDLES_COMPACTION_PLAN.md).
//
// Every value of a `broker_candles` row is kept and reproducible:
//  - values constant for a native series live once in broker_candle_series;
//  - per-bar text with very few distinct values (source, terminal, price
//    basis, quality status and reason) lives once in broker_candle_attrs;
//  - a bar row holds prices, volumes, flags and times. A time that equals a
//    value computable from the bar itself is stored NULL and its bit is set in
//    `derived`; a NULL with the bit clear is a real NULL.

/** One native series: the old table's unique key minus the bar time, plus the
 * values constant across its bars. For a current history identity those
 * values are part of the identity hash, so there is one series per native
 * key (the writer enforces it). Legacy-identity rows may vary in account or
 * symbol within one native key; each variant is its own series, so nothing is
 * relabelled. `seriesKey` is the exact JSON of all nine values. */
export const brokerCandleSeriesTable = pgTable(
  "broker_candle_series",
  {
    id: serial("id").primaryKey(),
    seriesKey: text("series_key").notNull(),
    bridgeConnectionId: integer("bridge_connection_id").notNull(),
    historyIdentity: text("history_identity").notNull(),
    brokerSymbol: text("broker_symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    userId: integer("user_id").notNull(),
    symbol: text("symbol").notNull(),
    accountNumber: text("account_number"),
    serverName: text("server_name"),
    clockBasis: text("clock_basis"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    seriesKeyUq: uniqueIndex("broker_candle_series_key_uq").on(t.seriesKey),
    nativeIdx: index("broker_candle_series_native_idx").on(
      t.bridgeConnectionId, t.historyIdentity, t.brokerSymbol, t.timeframe),
    readIdx: index("broker_candle_series_read_idx").on(t.userId, t.symbol, t.timeframe),
  }),
);

/** Distinct per-bar text attributes. `attrsKey` is their exact JSON tuple. */
export const brokerCandleAttrsTable = pgTable(
  "broker_candle_attrs",
  {
    id: serial("id").primaryKey(),
    attrsKey: text("attrs_key").notNull(),
    source: text("source").notNull(),
    terminalId: text("terminal_id"),
    priceBasis: text("price_basis"),
    qualityStatus: text("quality_status").notNull(),
    qualityReason: text("quality_reason"),
  },
  (t) => ({ attrsKeyUq: uniqueIndex("broker_candle_attrs_key_uq").on(t.attrsKey) }),
);

/** Bits of `brokerCandleBarsTable.derived`. */
export const BAR_DERIVED = {
  /** created_at = received_at */
  CREATED_AT: 1,
  /** close_time_utc = open_time_utc + interval (fixed-length timeframes only) */
  CLOSE_TIME: 2,
  /** raw_open_time = open_time_utc */
  RAW_OPEN: 4,
  /** raw_close_time = raw_open_time + interval (fixed-length timeframes only) */
  RAW_CLOSE: 8,
} as const;

export const brokerCandleBarsTable = pgTable(
  "broker_candle_bars",
  {
    // 8-byte columns first (row alignment).
    openTimeUtc: timestamp("open_time_utc", { withTimezone: true }).notNull(),
    closeTimeUtc: timestamp("close_time_utc", { withTimezone: true }),
    brokerServerTime: timestamp("broker_server_time", { withTimezone: true }),
    rawOpenTime: timestamp("raw_open_time", { withTimezone: true }),
    rawCloseTime: timestamp("raw_close_time", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    tickVolume: doublePrecision("tick_volume"),
    realVolume: doublePrecision("real_volume"),
    spread: doublePrecision("spread"),
    seriesId: integer("series_id").notNull().references(() => brokerCandleSeriesTable.id),
    // The original broker_candles.id for copied rows; NULL for bars written here.
    legacyId: integer("legacy_id"),
    attrsId: integer("attrs_id").notNull().references(() => brokerCandleAttrsTable.id),
    derived: smallint("derived").notNull().default(0),
    isClosedBar: boolean("is_closed_bar").notNull().default(true),
    tickVolumeObserved: boolean("tick_volume_observed").notNull().default(false),
  },
  (t) => ({
    // One bar per series and open instant: the old unique key, in one index.
    pk: primaryKey({ name: "broker_candle_bars_pk", columns: [t.seriesId, t.openTimeUtc] }),
  }),
);

/** Progress of the one-time copy from broker_candles (single row, id = 1).
 * `lastId` is the highest broker_candles.id copied and verified. */
export const brokerCandleCompactProgressTable = pgTable("broker_candle_compact_progress", {
  id: integer("id").primaryKey(),
  lastId: bigint("last_id", { mode: "number" }).notNull().default(0),
  rowsCopied: bigint("rows_copied", { mode: "number" }).notNull().default(0),
  rowsSuperseded: bigint("rows_superseded", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BrokerCandleSeries = typeof brokerCandleSeriesTable.$inferSelect;
export type BrokerCandleAttrs = typeof brokerCandleAttrsTable.$inferSelect;
export type BrokerCandleBar = typeof brokerCandleBarsTable.$inferSelect;
export type NewBrokerCandleBar = typeof brokerCandleBarsTable.$inferInsert;
