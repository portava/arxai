import {
  pgTable, serial, integer, text, real, boolean, timestamp, jsonb,
  index, uniqueIndex,
} from "drizzle-orm/pg-core";

// Phase UX7 — Trade Decision Orchestrator.
//
// SAFETY:
//   * Every row is user-scoped (user_id NOT NULL). Reads MUST filter by
//     req.authUser.id. Trade ownership is re-checked via resolveUserTrade
//     on every endpoint.
//   * A trade_decision row is decision support only. It never triggers an
//     order, never moves a stop, never closes a position. All exec
//     buttons in the UI open a review modal first.
//   * (user_id, trade_key) is unique — latest snapshot wins via upsert.
//   * Scores are 0..100; null = "data insufficient". data_quality lists
//     missing inputs honestly — no fabrication.

export const tradeDecisionsTable = pgTable("trade_decisions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  routingMode: text("routing_mode").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),

  decisionLabel: text("decision_label").notNull(),
  decisionAction: text("decision_action").notNull(),

  confidenceScore: real("confidence_score"),
  urgencyScore: real("urgency_score"),
  riskScore: real("risk_score"),

  reasonSummary: text("reason_summary"),
  mainReason: text("main_reason"),
  supportingReasons: jsonb("supporting_reasons"),

  invalidationLevel: real("invalidation_level"),
  protectProfitLevel: real("protect_profit_level"),
  continuationLevel: real("continuation_level"),

  suggestedButton: text("suggested_button"),
  requiresConfirmation: boolean("requires_confirmation").notNull().default(true),

  dataQuality: jsonb("data_quality"),
  source: text("source"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userTradeIdx: index("trade_decisions_user_trade_idx").on(t.userId, t.tradeKey, t.createdAt),
  userLatestUnique: uniqueIndex("trade_decisions_user_trade_unique").on(t.userId, t.tradeKey),
}));

export type TradeDecisionRow = typeof tradeDecisionsTable.$inferSelect;
