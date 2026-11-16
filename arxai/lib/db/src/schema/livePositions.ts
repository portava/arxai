import { pgTable, serial, integer, text, real, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

// Build H — Live Position Management.
// `tradesTable` is the system-of-record row for an order; `live_positions` is
// the live-state mirror that the position-monitor service updates on every
// MT5 sync. `position_events` is the append-only timeline (warnings, SL/TP
// changes, fills, manual closes). Neither table holds anything the broker
// doesn't already report — they exist so the UI / AI Coach / scoring engines
// can subscribe to position-level state without scanning JSONB.

export const livePositionsTable = pgTable("live_positions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tradeId: integer("trade_id"),                              // FK → trades.id (loose)
  brokerPositionId: text("broker_position_id"),              // EA ticket as string
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),                    // BUY | SELL
  lotSize: real("lot_size").notNull(),
  entryPrice: real("entry_price").notNull(),
  currentPrice: real("current_price"),
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  unrealizedProfitLoss: real("unrealized_profit_loss"),
  realizedProfitLoss: real("realized_profit_loss"),
  rewardToRisk: real("reward_to_risk"),
  status: text("status").notNull().default("SYNC_PENDING"),  // LivePositionStatus
  openedAt: timestamp("opened_at"),
  closedAt: timestamp("closed_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // UX9 hardening — tenant-safe uniqueness. MT5 ticket numbers are only
  // unique within a broker account, so the global unique index on
  // broker_position_id alone allowed cross-tenant collisions. The composite
  // (user_id, broker_position_id) is the correct grain; NULLS NOT DISTINCT
  // preserves idempotency for the central /positions/sync feed which
  // currently inserts user_id=NULL rows (would otherwise be allowed to
  // duplicate by Postgres default NULL handling).
  // NOTE: NULLS NOT DISTINCT is applied at the DB level via raw SQL
  // (see migration in commit history). drizzle-orm 0.45 IndexBuilder does
  // not yet expose `.nullsNotDistinct()`; if `drizzle-kit push` is run later
  // it may try to recreate the index without that clause — re-apply the
  // raw SQL after any such push:
  //   DROP INDEX live_positions_user_broker_position_uq;
  //   CREATE UNIQUE INDEX live_positions_user_broker_position_uq
  //     ON live_positions (user_id, broker_position_id) NULLS NOT DISTINCT;
  userBrokerPositionUq: uniqueIndex("live_positions_user_broker_position_uq")
    .on(t.userId, t.brokerPositionId),
}));

// Append-only — never UPDATE/DELETE (enforced by no-vault-mutation guard).
export const positionEventsTable = pgTable("position_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  livePositionId: integer("live_position_id").notNull(),
  eventType: text("event_type").notNull(),                   // SYNC, SL_NEAR, SL_REMOVED, SL_MOVED, TP_HIT, SL_HIT, MANUAL_CLOSE, BROKER_ERROR, RISK_WARNING, OPENED, CLOSED
  severity: text("severity").notNull().default("INFO"),      // INFO | WARN | DANGER
  message: text("message").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type LivePosition = typeof livePositionsTable.$inferSelect;
export type PositionEvent = typeof positionEventsTable.$inferSelect;
