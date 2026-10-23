import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (S) Build S — AI Accountability & Rule Contract System.
// Soft accountability layer. Reads paper_orders (Build Q) for evaluation.
// Hard locks NOT enforced here — that authority remains with safetyCore + Risk
// Lock. This system records, warns, and surfaces violations for AI Coach +
// Trader Growth Score consumption.

export const tradingRuleContractsTable = pgTable("trading_rule_contracts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  contractName: text("contract_name").notNull().default("My Rules"),
  // Rules — null means rule is not enforced.
  maxTradesPerDay: integer("max_trades_per_day"),
  maxDailyLossPercent: real("max_daily_loss_percent"), // 0..1
  maxRiskPerTradePercent: real("max_risk_per_trade_percent"), // 0..1
  allowedSessions: text("allowed_sessions").notNull().default("ASIA,LONDON,NEWYORK"), // CSV
  allowedSymbols: text("allowed_symbols").notNull().default(""), // CSV; empty = any
  requiredRrMinimum: real("required_rr_minimum"), // e.g. 2.0
  cooldownAfterLosses: integer("cooldown_after_losses"), // stop after N consecutive losses
  noTradeConditions: text("no_trade_conditions").notNull().default(""), // free-text checklist (CSV)
  isActive: integer("is_active").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byActive: index("trading_rule_contracts_active_idx").on(t.isActive),
}));
export type TradingRuleContract = typeof tradingRuleContractsTable.$inferSelect;

export const tradingRuleViolationsTable = pgTable("trading_rule_violations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  contractId: integer("contract_id").notNull(),
  tradeId: integer("trade_id"), // paper_orders.id (advisory only, no FK)
  // OVER_TRADES | DAILY_LOSS | OVER_RISK | DISALLOWED_SESSION | DISALLOWED_SYMBOL | LOW_RR | COOLDOWN | OTHER
  violationType: text("violation_type").notNull(),
  severity: text("severity").notNull().default("WARN"), // INFO | WARN | HARD
  message: text("message").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byContract: index("trading_rule_violations_contract_idx").on(t.contractId),
  byCreated:  index("trading_rule_violations_created_idx").on(t.createdAt),
}));
export type TradingRuleViolation = typeof tradingRuleViolationsTable.$inferSelect;

export const sessionCommitmentsTable = pgTable("session_commitments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  contractId: integer("contract_id").notNull(),
  sessionDate: text("session_date").notNull(), // YYYY-MM-DD UTC
  commitmentText: text("commitment_text").notNull().default(""),
  // ACTIVE | ENDED | ABANDONED
  status: text("status").notNull().default("ACTIVE"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byStatus: index("session_commitments_status_idx").on(t.status),
  byDate:   index("session_commitments_date_idx").on(t.sessionDate),
}));
export type SessionCommitment = typeof sessionCommitmentsTable.$inferSelect;
