import { pgTable, serial, integer, text, real, jsonb, timestamp, index } from "drizzle-orm/pg-core";

// (T) Build T — Session Preparation & Trading Readiness System.
// Pre-session readiness check: rolls up signals from safetyCore, riskLocks,
// brokerHealth, economicEvents, ruleContracts, weeklyReviews + the trader's
// self-reported mental state. Status is ADVISORY — execution authority remains
// with safetyCore.canPlaceTrades + the broker auth gate.

export const tradingReadinessChecksTable = pgTable("trading_readiness_checks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  sessionName: text("session_name").notNull().default("PRE_SESSION"),
  // 0..100 composite. Drops as items fail.
  readinessScore: real("readiness_score").notNull().default(0),
  // Self-report (1..5 each, null = not yet entered)
  mentalState: integer("mental_state"),
  sleepQuality: integer("sleep_quality"),
  stressLevel: integer("stress_level"),
  confidenceLevel: integer("confidence_level"),
  // Derived snapshots (text label per system)
  marketCondition: text("market_condition").notNull().default("UNKNOWN"),
  brokerStatus: text("broker_status").notNull().default("UNKNOWN"),
  newsRiskLevel: text("news_risk_level").notNull().default("NONE"),
  strategyReady: integer("strategy_ready").notNull().default(0),       // bool 0/1
  riskRulesConfirmed: integer("risk_rules_confirmed").notNull().default(0),
  aiSummary: text("ai_summary").notNull().default(""),
  // READY | CAUTION | NOT_READY | LOCKED
  status: text("status").notNull().default("NOT_READY"),
  // Full structured checklist + reasons for audit
  checklist: jsonb("checklist").notNull().default([]),
  reasons:   jsonb("reasons").notNull().default([]),
  warnings:  jsonb("warnings").notNull().default([]),
  blockers:  jsonb("blockers").notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCreated: index("trading_readiness_created_idx").on(t.createdAt),
  byStatus:  index("trading_readiness_status_idx").on(t.status),
}));
export type TradingReadinessCheck = typeof tradingReadinessChecksTable.$inferSelect;
