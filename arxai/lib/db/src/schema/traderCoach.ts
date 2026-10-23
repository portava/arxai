// Build II — Trader Coach + Playbook Generator.
//
// SAFETY (strict freeze): Coaching, playbook, review, and improvement
// planning ONLY. NEVER places trades, NEVER calls MT5, NEVER enables
// canPlaceTrades, NEVER recommends live trading.

import { pgTable, serial, text, integer, real, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const traderCoachReportsTable = pgTable("trader_coach_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  coachReportId: text("coach_report_id").notNull(),
  reportType: text("report_type").notNull(),
  mode: text("mode").notNull().default("PAPER_ONLY"),
  liveTradingStatus: text("live_trading_status").notNull().default("DISABLED"),
  readinessScore: real("readiness_score").notNull().default(0),
  readinessGrade: text("readiness_grade").notNull().default("F"),
  readinessLevel: text("readiness_level").notNull().default("NOT_READY"),
  governorStatus: text("governor_status").notNull().default("UNKNOWN"),
  performanceSummary: jsonb("performance_summary").notNull().default({}),
  topStrengths: jsonb("top_strengths").notNull().default([]),
  topWeaknesses: jsonb("top_weaknesses").notNull().default([]),
  repeatedMistakes: jsonb("repeated_mistakes").notNull().default([]),
  activeRiskFlags: jsonb("active_risk_flags").notNull().default([]),
  currentFocusAreas: jsonb("current_focus_areas").notNull().default([]),
  nextBestActions: jsonb("next_best_actions").notNull().default([]),
  preSessionChecklist: jsonb("pre_session_checklist").notNull().default([]),
  postSessionReviewQuestions: jsonb("post_session_review_questions").notNull().default([]),
  playbookUpdates: jsonb("playbook_updates").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  coachingSummary: text("coaching_summary").notNull().default(""),
  generatedBy: text("generated_by").notNull().default("SYSTEM_TRADER_COACH"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reportIdIdx: uniqueIndex("trader_coach_reports_report_id_uq").on(t.coachReportId),
  createdIdx: index("trader_coach_reports_created_idx").on(t.createdAt),
  typeIdx: index("trader_coach_reports_type_idx").on(t.reportType),
}));

export const tradingPlaybookEntriesTable = pgTable("trading_playbook_entries", {
  id: serial("id").primaryKey(),
  playbookEntryId: text("playbook_entry_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("WATCHLIST"),
  symbol: text("symbol").notNull().default(""),
  timeframe: text("timeframe").notNull().default(""),
  setupName: text("setup_name").notNull().default(""),
  actionBias: text("action_bias").notNull().default(""),
  conditionsRequired: jsonb("conditions_required").notNull().default([]),
  entryRules: jsonb("entry_rules").notNull().default([]),
  riskRules: jsonb("risk_rules").notNull().default([]),
  invalidationRules: jsonb("invalidation_rules").notNull().default([]),
  marketDataRequirements: jsonb("market_data_requirements").notNull().default([]),
  sniperEntryRequirements: jsonb("sniper_entry_requirements").notNull().default([]),
  mistakeWarnings: jsonb("mistake_warnings").notNull().default([]),
  confidenceLevel: text("confidence_level").notNull().default("LOW"),
  sampleSize: integer("sample_size").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  avgPnl: real("avg_pnl").notNull().default(0),
  edgeScore: real("edge_score").notNull().default(0),
  source: text("source").notNull().default("SYSTEM_GENERATED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entryIdIdx: uniqueIndex("trading_playbook_entry_id_uq").on(t.playbookEntryId),
  cohortIdx: uniqueIndex("trading_playbook_cohort_uq").on(t.symbol, t.setupName, t.actionBias),
  statusIdx: index("trading_playbook_status_idx").on(t.status),
  symbolIdx: index("trading_playbook_symbol_idx").on(t.symbol),
}));

export const weeklyImprovementPlansTable = pgTable("weekly_improvement_plans", {
  id: serial("id").primaryKey(),
  weekStart: text("week_start").notNull(),
  weekEnd: text("week_end").notNull(),
  mainGoal: text("main_goal").notNull().default(""),
  focusAreas: jsonb("focus_areas").notNull().default([]),
  rulesToPractice: jsonb("rules_to_practice").notNull().default([]),
  mistakesToReduce: jsonb("mistakes_to_reduce").notNull().default([]),
  setupsToStudy: jsonb("setups_to_study").notNull().default([]),
  setupsToAvoid: jsonb("setups_to_avoid").notNull().default([]),
  paperTradingTargets: jsonb("paper_trading_targets").notNull().default({}),
  progressMetrics: jsonb("progress_metrics").notNull().default([]),
  reviewQuestions: jsonb("review_questions").notNull().default([]),
  successCriteria: jsonb("success_criteria").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  weekIdx: uniqueIndex("weekly_improvement_plans_week_uq").on(t.weekStart),
  createdIdx: index("weekly_improvement_plans_created_idx").on(t.createdAt),
}));

export const traderCoachLogsTable = pgTable("trader_coach_logs", {
  id: serial("id").primaryKey(),
  coachReportId: text("coach_report_id").notNull().default(""),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("INFO"),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reportIdIdx: index("trader_coach_logs_report_id_idx").on(t.coachReportId),
  createdIdx: index("trader_coach_logs_created_idx").on(t.createdAt),
}));
