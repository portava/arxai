import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Chart Brain v2 — Task 6: interactive chart surfaces (command actions + AI-aware
// alerts). Both tables are SLOW BRAIN / decision-support only. They are NEVER read
// on the live execution path and NEVER place, modify, or close an order. Every row
// is strictly PER-USER (carries `user_id`; every read is scoped by it).
//
// SAFETY:
//  - additive only (no existing table/column is altered);
//  - annotations are soft-deleted via `status` (never hard-deleted from the API);
//  - nothing here ever dispatches a trade or relaxes a safety gate.

// ── 1. Per-user chart annotations ───────────────────────────────────────────
// Marked support/resistance levels, watch zones, and user-defined price alerts
// created from the chart command menu. Price alerts are evaluated (read-only) by
// the AI-alert scan and fire through the existing notification system — they
// NEVER execute a trade.
export const chartAnnotationsTable = pgTable(
  "chart_annotations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    symbol: text("symbol").notNull(),
    displaySymbol: text("display_symbol"),
    timeframe: text("timeframe").notNull().default("M5"),
    // SUPPORT | RESISTANCE | WATCH_ZONE | PRICE_ALERT
    kind: text("kind").notNull(),
    // For PRICE_ALERT: "above" | "below" (price-cross direction). null otherwise.
    direction: text("direction"),
    price: doublePrecision("price").notNull(),
    // Optional upper bound for WATCH_ZONE (a band low=price, high=price_to).
    priceTo: doublePrecision("price_to"),
    note: text("note"),
    // active | triggered | dismissed
    status: text("status").notNull().default("active"),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSymbolIdx: index("chart_annotations_user_symbol_idx").on(
      t.userId,
      t.symbol,
      t.status,
    ),
    userStatusIdx: index("chart_annotations_user_status_idx").on(
      t.userId,
      t.status,
    ),
  }),
);

export type ChartAnnotation = typeof chartAnnotationsTable.$inferSelect;
export type NewChartAnnotation = typeof chartAnnotationsTable.$inferInsert;

// ── 2. Per-user chart alert transition state ────────────────────────────────
// Last intelligence snapshot per (user, symbol, timeframe). The AI-alert scan
// compares the current Chart Intelligence State against this snapshot to detect
// meaningful STATE TRANSITIONS (level cross/hold, risk-veto on/off, setup
// watchlist→active→stale, invalidation, agent-court conflict→agreement, etc.).
// Only a compact set of transition-relevant fields is stored — never full candle
// history. One row per user+symbol+timeframe (upserted in place).
export const chartAlertStateTable = pgTable(
  "chart_alert_state",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    // Compact transition-relevant snapshot (setup stage, actionability, vetoed,
    // level personalities, agent conflict, stale, lastClose, invalidationPrice).
    lastSnapshot: jsonb("last_snapshot").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSymbolTfUnique: uniqueIndex("chart_alert_state_user_symbol_tf_unique").on(
      t.userId,
      t.symbol,
      t.timeframe,
    ),
  }),
);

export type ChartAlertState = typeof chartAlertStateTable.$inferSelect;
export type NewChartAlertState = typeof chartAlertStateTable.$inferInsert;
