import { pgTable, serial, integer, text, jsonb, timestamp, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 11 contract: every trade is preceded by an explicit plan that the
// risk manager either APPROVES, asks to WAIT on, or BLOCKS.
//
// Build K — extended additively for the AI Trade Plan Builder. The original
// columns (signalId, finalRecommendation, marketThesis, invalidation,
// managementPlan, riskAuditJson) remain in place for back-compat with the
// risk-manager flow; new nullable columns hold the user-facing pre-trade
// plan fields. Status drives the DRAFT → READY → EXECUTED lifecycle.

export const TRADE_PLAN_STATUSES = [
  "DRAFT",         // user is still composing
  "READY",         // checklist passed → eligible for conversion to confirmation
  "INVALIDATED",   // checklist failed (markets moved, risk lock, etc.)
  "EXECUTED",      // converted to an execution_confirmation
  "CANCELED",      // user abandoned
] as const;
export type TradePlanStatus = (typeof TRADE_PLAN_STATUSES)[number];

export const tradePlansTable = pgTable("trade_plans", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id"),
  userId: integer("user_id"),

  // Build K — user-built plan fields (all nullable for back-compat).
  symbol: text("symbol"),
  directionBias: text("direction_bias"),                 // BUY | SELL | NEUTRAL
  strategyId: text("strategy_id"),
  marketCondition: text("market_condition"),             // TRENDING | RANGING | NO_TRADE | UNKNOWN
  entryConditions: text("entry_conditions"),
  invalidationConditions: text("invalidation_conditions"),
  stopLossPlan: text("stop_loss_plan"),
  takeProfitPlan: text("take_profit_plan"),

  // Numeric levels (used to convert into an execution confirmation)
  entryPrice: real("entry_price"),
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  lotSize: real("lot_size"),
  riskAmount: real("risk_amount"),
  maxLossAllowed: real("max_loss_allowed"),
  rewardToRiskTarget: real("reward_to_risk_target"),
  confidenceLevel: integer("confidence_level"),          // 0..100

  status: text("status").notNull().default("DRAFT"),
  aiSummary: text("ai_summary"),

  // Soft links to downstream surfaces (set when validate / convert run).
  checklistJson: jsonb("checklist_json"),                // last validation result
  executionConfirmationId: integer("execution_confirmation_id"),

  // Phase 11 risk-manager flow — kept for back-compat. Now nullable so the
  // user-facing builder doesn't have to set them.
  finalRecommendation: text("final_recommendation"),
  marketThesis: text("market_thesis").notNull().default(""),
  invalidation: text("invalidation").notNull().default(""),
  managementPlan: text("management_plan").notNull().default(""),
  riskAuditJson: jsonb("risk_audit_json"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byStatus: index("trade_plans_status_idx").on(t.status),
  byCreated: index("trade_plans_created_idx").on(t.createdAt),
}));

export const insertTradePlanSchema = createInsertSchema(tradePlansTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTradePlan = z.infer<typeof insertTradePlanSchema>;
export type TradePlan = typeof tradePlansTable.$inferSelect;
