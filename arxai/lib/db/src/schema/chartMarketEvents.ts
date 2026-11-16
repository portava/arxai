import {
  pgTable,
  serial,
  text,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Chart Brain v2 — Task 2: market-memory store for the Level Personality engine.
//
// These rows are MARKET FACTS (what a price level did on a chart), not user
// data — exactly like candles, which are also not per-user. They are keyed by
// symbol + timeframe so any user viewing the same chart sees the same level
// history. The /me/chart/intelligence endpoint that reads them stays per-user
// gated; the events themselves carry no user identity.
//
// We store only MEANINGFUL events (held / rejected / breakout / failed_breakout
// / retest / wick_trap), never every candle. Writes are best-effort and
// fire-and-forget from the Fast Brain so they never block candle render; reads
// are a single indexed lookup that degrades to window-only personality when the
// table is empty or unavailable.

export const chartMarketEventsTable = pgTable(
  "chart_market_events",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    // held | rejected | breakout | failed_breakout | retest | wick_trap
    eventType: text("event_type").notNull(),
    // support | resistance (the level the event acted on)
    levelKind: text("level_kind").notNull(),
    price: real("price").notNull(),
    // Close time of the candle on which the event was observed.
    barTime: timestamp("bar_time").notNull(),
    // ATR at the time of the event, for proportional comparison later. Nullable.
    atrAtEvent: real("atr_at_event"),
    meta: jsonb("meta").notNull().default({}),
    detectedAt: timestamp("detected_at").defaultNow().notNull(),
  },
  (t) => ({
    // One event of a given type at a given bar time per symbol/timeframe — the
    // dedupe key for the idempotent best-effort writer.
    uniqueEvent: uniqueIndex("chart_market_events_unique").on(
      t.symbol,
      t.timeframe,
      t.eventType,
      t.barTime,
    ),
    // Fast "recent events for this chart" read.
    bySymbolTf: index("chart_market_events_symbol_tf").on(
      t.symbol,
      t.timeframe,
      t.barTime,
    ),
  }),
);

export type ChartMarketEvent = typeof chartMarketEventsTable.$inferSelect;
export type NewChartMarketEvent = typeof chartMarketEventsTable.$inferInsert;
