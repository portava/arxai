import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Broker-candle backfill state machine (Task #469, Phase A) ────────────────
//
// One row per (bridge_connection_id, broker_symbol, timeframe) tracking how far
// the deep-history backfill for that series has progressed. This lets the
// server tell an EA WHERE to keep streaming (the next page to CopyRates) and
// lets diagnostics show honest coverage instead of guessing.
//
// STATUS state machine (computed by computeBackfillStatus, pure fn):
//   NOT_STARTED    — no bars stored yet for this series.
//   BUILDING       — bars are arriving (a recent ingest) but the depth target
//                    is not yet met.
//   PARTIAL        — some history stored, target not met, and no recent ingest
//                    (streaming appears paused).
//   COMPLETE       — stored coverage meets/exceeds the per-timeframe depth target.
//   BROKER_LIMITED — the EA reported the broker has no older bars available, so
//                    the series is as deep as it can ever get (honest ceiling).
//   ERROR          — an ingest error was recorded; needs operator attention.
//
// SAFETY SCOPE: MARKET-DATA / TELEMETRY ONLY. Never touches execution, the
// 16-gate live pipeline, `arx_live_*`, balances, or fills.
export const brokerCandleBackfillStatusTable = pgTable(
  "broker_candle_backfill_status",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    bridgeConnectionId: integer("bridge_connection_id").notNull(),
    brokerSymbol: text("broker_symbol").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    // NOT_STARTED | BUILDING | PARTIAL | COMPLETE | BROKER_LIMITED | ERROR
    status: text("status").notNull().default("NOT_STARTED"),
    statusReason: text("status_reason"),
    oldestStoredAt: timestamp("oldest_stored_at", { withTimezone: true }),
    newestStoredAt: timestamp("newest_stored_at", { withTimezone: true }),
    barsStored: integer("bars_stored").notNull().default(0),
    // The per-timeframe depth target (days) used to judge COMPLETE.
    targetDays: integer("target_days"),
    // Observed coverage (days) between oldest and newest stored bar.
    coverageDays: doublePrecision("coverage_days"),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("broker_candle_backfill_bridge_sym_tf_uq").on(
      t.bridgeConnectionId,
      t.brokerSymbol,
      t.timeframe,
    ),
  }),
);

export type BrokerCandleBackfillStatus =
  typeof brokerCandleBackfillStatusTable.$inferSelect;
export type NewBrokerCandleBackfillStatus =
  typeof brokerCandleBackfillStatusTable.$inferInsert;
