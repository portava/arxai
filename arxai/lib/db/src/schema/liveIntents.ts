// Build TT — Live Intent Queue (FULL TESTER ACCESS mode).
//
// Captures live-style trade intents from the tester UI WITHOUT ever touching
// MT5, live_positions, mt5_commands, or placeLiveOrderGuarded(). Every row
// here is paper/intent metadata only. The presence of an intent does NOT
// authorise broker execution; that still requires the guarded order router
// + a real MT5 bridge connection.
import {
  pgTable, serial, text, integer, doublePrecision, jsonb, boolean, timestamp, index,
} from "drizzle-orm/pg-core";

export const liveIntentsTable = pgTable("live_intents", {
  id: serial("id").primaryKey(),
  intentId: text("intent_id").notNull().unique(),
  source: text("source").notNull(),                     // MANUAL | AI_ASSIST | AI_AUTO
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),               // BUY | SELL
  orderType: text("order_type").notNull().default("MARKET"), // MARKET | LIMIT | STOP
  lotSize: doublePrecision("lot_size").notNull(),
  entryPrice: doublePrecision("entry_price"),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),
  estimatedRisk: doublePrecision("estimated_risk"),
  maxLossUsd: doublePrecision("max_loss_usd"),
  maxLossPercent: doublePrecision("max_loss_percent"),
  confidenceScore: integer("confidence_score"),
  riskScore: integer("risk_score"),
  riskRewardRatio: doublePrecision("risk_reward_ratio"),
  reasonForTrade: text("reason_for_trade"),
  invalidationReason: text("invalidation_reason"),
  marketCondition: text("market_condition"),
  note: text("note"),
  status: text("status").notNull(),                     // TESTER_CAPTURED | PENDING_MT5_CONNECTION | REJECTED_BY_RISK | READY_FOR_BROKER_WHEN_CONNECTED | EXECUTED_LATER
  rejectionReason: text("rejection_reason"),
  riskCheckPassed: boolean("risk_check_passed").notNull().default(false),
  riskCheckDetails: jsonb("risk_check_details").notNull().default({}),
  mt5ConnectedAtSubmit: boolean("mt5_connected_at_submit").notNull().default(false),
  brokerExecuted: boolean("broker_executed").notNull().default(false),
  auditEventId: integer("audit_event_id"),
  journalEntryId: integer("journal_entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("live_intents_status_idx").on(t.status),
  sourceIdx: index("live_intents_source_idx").on(t.source),
  createdAtIdx: index("live_intents_created_at_idx").on(t.createdAt),
}));

export type LiveIntent = typeof liveIntentsTable.$inferSelect;
export type NewLiveIntent = typeof liveIntentsTable.$inferInsert;
