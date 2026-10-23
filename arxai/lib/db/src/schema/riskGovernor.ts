// Build HH — Risk Governor + Trader Readiness System.
//
// SAFETY (strict freeze): Reporting + governance only. NEVER places trades,
// NEVER calls MT5, NEVER enables canPlaceTrades, NEVER recommends live trading.
// liveTradingStatus is hardcoded "DISABLED" everywhere this build touches.

import { pgTable, serial, text, integer, real, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const riskGovernorEvaluationsTable = pgTable("risk_governor_evaluations", {
  id: serial("id").primaryKey(),
  governorId: text("governor_id").notNull(),
  overallStatus: text("overall_status").notNull(),
  mode: text("mode").notNull().default("PAPER_ONLY"),
  liveTradingStatus: text("live_trading_status").notNull().default("DISABLED"),
  readinessScore: real("readiness_score").notNull().default(0),
  readinessGrade: text("readiness_grade").notNull().default("F"),
  readinessLevel: text("readiness_level").notNull().default("NOT_READY"),
  paperTradingAllowed: boolean("paper_trading_allowed").notNull().default(false),
  autopilotAllowed: boolean("autopilot_allowed").notNull().default(false),
  manualPaperAllowed: boolean("manual_paper_allowed").notNull().default(true),
  liveTradingAllowed: boolean("live_trading_allowed").notNull().default(false),
  hardBlocks: jsonb("hard_blocks").notNull().default([]),
  softWarnings: jsonb("soft_warnings").notNull().default([]),
  riskFlags: jsonb("risk_flags").notNull().default([]),
  cooldowns: jsonb("cooldowns").notNull().default([]),
  metrics: jsonb("metrics").notNull().default({}),
  nextBestActions: jsonb("next_best_actions").notNull().default([]),
  allowedActions: jsonb("allowed_actions").notNull().default({}),
  explanation: text("explanation").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  governorIdIdx: uniqueIndex("risk_gov_eval_governor_id_uq").on(t.governorId),
  createdIdx: index("risk_gov_eval_created_idx").on(t.createdAt),
}));

export const riskGovernorEventsTable = pgTable("risk_governor_events", {
  id: serial("id").primaryKey(),
  governorId: text("governor_id").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("INFO"),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  governorIdIdx: index("risk_gov_event_governor_id_idx").on(t.governorId),
  createdIdx: index("risk_gov_event_created_idx").on(t.createdAt),
}));
