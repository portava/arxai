import { pgTable, serial, integer, text, real, jsonb, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// (AA) Build AA — Trade Decision Orchestrator.
// Append-only log of every decision the central orchestrator produces.
// Each row captures the full structured decision object so it can be
// replayed, reviewed, or fed back into Build CC (outcome → edge → score).
//
// SAFETY: writes are advisory only. The orchestrator never mutates
// safetyCore.canPlaceTrades, never calls execute-trade, never touches
// live_positions / mt5_*. The decision is persisted so the user (and
// future Build BB auto-debrief) has an auditable trail.

export const tradeDecisionLogsTable = pgTable("trade_decision_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  symbol: text("symbol").notNull(),
  // BUY | SELL | HOLD
  action: text("action").notNull().default("HOLD"),
  shouldTrade: boolean("should_trade").notNull().default(false),
  confidence: real("confidence").notNull().default(0),     // 0..100
  riskScore:  real("risk_score").notNull().default(0),     // 0..100 (higher = riskier)
  entryReason:        text("entry_reason").notNull().default(""),
  invalidationReason: text("invalidation_reason").notNull().default(""),
  stopLoss:     real("stop_loss"),
  takeProfit:   real("take_profit"),
  positionSize: real("position_size"),
  // GOOD | WAIT | AVOID
  tradeWindowStatus: text("trade_window_status").notNull().default("WAIT"),
  tradeWindowReason: text("trade_window_reason").notNull().default(""),
  // Full structured decision object (signalsUsed, warnings, scoresPerSignal, etc.)
  decisionJson: jsonb("decision_json").notNull().default({}),
  // OBSERVE_ONLY | SUGGEST_ONLY | PAPER_TRADING | LIVE_TRADING
  operationalMode: text("operational_mode").notNull().default("PAPER_TRADING"),
  // Whether at decision time the system was in mock-data mode.
  syntheticData: boolean("synthetic_data").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  bySymbol:  index("trade_decision_logs_symbol_idx").on(t.symbol),
  byAction:  index("trade_decision_logs_action_idx").on(t.action),
  byCreated: index("trade_decision_logs_created_idx").on(t.createdAt),
}));

export const insertTradeDecisionLogSchema = createInsertSchema(tradeDecisionLogsTable).omit({ id: true, createdAt: true });
export type InsertTradeDecisionLog = z.infer<typeof insertTradeDecisionLogSchema>;
export type TradeDecisionLog = typeof tradeDecisionLogsTable.$inferSelect;
