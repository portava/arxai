import { pgTable, serial, integer, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Append-only audit trail of every AI decision: what the brain saw, what it
// recommended, what risk said, what was actually done, and how it ended.
// Powers post-trade reviews, learning insights, and compliance review.
export const aiDecisionLogTable = pgTable("ai_decision_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column. Nullable for legacy rows.
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  symbol: text("symbol").notNull(),
  eventType: text("event_type").notNull(),
  // SIGNAL_GENERATED | TRADE_PLAN_CREATED | TRADE_OPENED | TRADE_MANAGED |
  // TRADE_CLOSED | RISK_BLOCKED | NEWS_BLOCKED | WAIT_RECOMMENDED |
  // ENTRY_MISSED | OVERRIDE_APPLIED | KILL_SWITCH
  aiReasoning: text("ai_reasoning").notNull().default(""),
  riskResult: text("risk_result").notNull().default("PENDING"), // APPROVED | WAIT | BLOCKED | OVERRIDDEN | N/A
  confidence: integer("confidence"),
  marketCondition: text("market_condition"),
  actionTaken: text("action_taken").notNull().default("NONE"),  // EXECUTED | DEFERRED | SKIPPED | CANCELLED | MODIFIED
  userOverride: boolean("user_override").notNull().default(false),
  finalOutcome: text("final_outcome"),                          // WIN | LOSS | BREAKEVEN | NO_TRADE | PENDING
  // Cross-reference foreign keys (nullable — not all decisions tie to a trade)
  signalId: integer("signal_id"),
  tradePlanId: integer("trade_plan_id"),
  tradeId: integer("trade_id"),
}, (t) => ({
  userIdx: index("ai_decision_log_user_id_idx").on(t.userId),
}));

export const insertAiDecisionLogSchema = createInsertSchema(aiDecisionLogTable).omit({ id: true, timestamp: true });
export type InsertAiDecisionLog = z.infer<typeof insertAiDecisionLogSchema>;
export type AiDecisionLog = typeof aiDecisionLogTable.$inferSelect;
