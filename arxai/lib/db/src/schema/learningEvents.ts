import { pgTable, serial, integer, text, real, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// (CC) Build CC — Learning Feedback Engine.
// Append-only log of every learning event the engine processes from a
// Build BB auto-debrief. The unique index on debrief_id is the
// foundation of idempotency: the same debrief can never be learned twice.
//
// SAFETY: this surface is observe/learn only. Build CC NEVER calls
// executeTrade/mt5_*/livePositions/setCanPlaceTrades/engageKillSwitch.
// The learning event records the input payload + computed adjustments.

export const learningEventsTable = pgTable("learning_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tradeId:    integer("trade_id").notNull(),                // paper_orders.id (advisory FK)
  decisionId: integer("decision_id"),                       // trade_decision_logs.id (advisory FK)
  debriefId:  integer("debrief_id").notNull(),              // post_trade_debriefs.id (advisory FK)
  symbol: text("symbol").notNull(),
  action: text("action").notNull(),                         // BUY | SELL | HOLD
  // WIN | LOSS | BREAKEVEN | CANCELLED — mirrors BB's classification.
  result: text("result").notNull(),
  pnl:         real("pnl").notNull().default(0),
  pnlPercent:  real("pnl_percent").notNull().default(0),
  confidenceBeforeTrade: real("confidence_before_trade"),   // nullable — no decision context
  riskScoreBeforeTrade:  real("risk_score_before_trade"),
  signalsUsed:  jsonb("signals_used").notNull().default([]),
  mistakeTags:  jsonb("mistake_tags").notNull().default([]),
  lesson:           text("lesson").notNull().default(""),
  learningSummary:  text("learning_summary").notNull().default(""),
  // Computed snapshot of all per-signal adjustments applied by this event,
  // so future audits can reconstruct exactly how each edge moved.
  adjustments:  jsonb("adjustments").notNull().default({}),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // Idempotency: one learning event per debrief, ever.
  byDebrief:  uniqueIndex("learning_events_debrief_uq").on(t.debriefId),
  byTrade:    index("learning_events_trade_idx").on(t.tradeId),
  byDecision: index("learning_events_decision_idx").on(t.decisionId),
  bySymbol:   index("learning_events_symbol_idx").on(t.symbol),
  byCreated:  index("learning_events_created_idx").on(t.createdAt),
}));
export type LearningEvent = typeof learningEventsTable.$inferSelect;
