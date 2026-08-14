// Build PP — Controlled Paper Testing Launch Mode + Session Manager schema.
//
// SAFETY: All tables additive. No live-trading flags. No secret columns.
// Sessions describe paper-only practice runs. liveTradingStatus is fixed to
// "DISABLED" everywhere. canPlaceTrades is never written.

import {
  pgTable, serial, text, integer, jsonb, boolean,
  timestamp, uniqueIndex, index, foreignKey,
} from "drizzle-orm/pg-core";

export const paperSessionsTable = pgTable("paper_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  paperSessionId: text("paper_session_id").notNull().unique(),
  status: text("status").notNull(),                     // READY|ACTIVE|PAUSED|ENDED|BLOCKED|FAILED
  mode: text("mode").notNull().default("PAPER_ONLY"),
  liveTradingStatus: text("live_trading_status").notNull().default("DISABLED"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  symbols: jsonb("symbols").notNull().default([]),
  timeframes: jsonb("timeframes").notNull().default([]),
  sessionGoals: jsonb("session_goals").notNull().default({}),
  sessionRules: jsonb("session_rules").notNull().default({}),
  preflightStatus: jsonb("preflight_status").notNull().default({}),
  readinessGateStatus: jsonb("readiness_gate_status").notNull().default({}),
  riskGovernorStatus: jsonb("risk_governor_status").notNull().default({}),
  securityStatus: jsonb("security_status").notNull().default({}),
  activeWarnings: jsonb("active_warnings").notNull().default([]),
  paperTradesOpened: integer("paper_trades_opened").notNull().default(0),
  paperTradesClosed: integer("paper_trades_closed").notNull().default(0),
  netPnl: integer("net_pnl").notNull().default(0),       // cents
  winRate: integer("win_rate").notNull().default(0),     // 0-100
  mistakesDetected: jsonb("mistakes_detected").notNull().default([]),
  lessonsGenerated: jsonb("lessons_generated").notNull().default([]),
  nextBestActions: jsonb("next_best_actions").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("paper_sessions_status_idx").on(t.status),
  startedIdx: index("paper_sessions_started_at_idx").on(t.startedAt),
  userIdx: index("paper_sessions_user_id_idx").on(t.userId),
}));

export const paperSessionEventsTable = pgTable("paper_session_events", {
  id: serial("id").primaryKey(),
  paperSessionId: text("paper_session_id").notNull(),
  eventType: text("event_type").notNull(),               // STARTED|PAUSED|RESUMED|ENDED|BLOCKED|EE_REJECT|FF_REJECT|TRADE_LINKED|REPORT_GENERATED|...
  severity: text("severity").notNull().default("INFO"),  // INFO|WARNING|HIGH|CRITICAL
  sourceBuild: text("source_build").notNull().default("PP"),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionFk: foreignKey({ columns: [t.paperSessionId], foreignColumns: [paperSessionsTable.paperSessionId] }).onDelete("cascade"),
  sessionIdx: index("paper_session_events_session_idx").on(t.paperSessionId),
  createdIdx: index("paper_session_events_created_idx").on(t.createdAt),
}));

export const paperSessionTradeLinksTable = pgTable("paper_session_trade_links", {
  id: serial("id").primaryKey(),
  paperSessionId: text("paper_session_id").notNull(),
  tradeId: text("trade_id"),
  decisionId: text("decision_id"),
  debriefId: text("debrief_id"),
  learningEventId: text("learning_event_id"),
  symbol: text("symbol"),
  action: text("action"),                                // OPEN|CLOSE|REJECT|LINK
  result: text("result"),                                // WIN|LOSS|BREAK_EVEN|OPEN
  pnl: integer("pnl").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionFk: foreignKey({ columns: [t.paperSessionId], foreignColumns: [paperSessionsTable.paperSessionId] }).onDelete("cascade"),
  sessionIdx: index("paper_session_trade_links_session_idx").on(t.paperSessionId),
  tradeIdx: index("paper_session_trade_links_trade_idx").on(t.tradeId),
}));

export const paperSessionReportsTable = pgTable("paper_session_reports", {
  id: serial("id").primaryKey(),
  sessionReportId: text("session_report_id").notNull(),
  paperSessionId: text("paper_session_id").notNull(),
  status: text("status").notNull(),                       // COMPLETE|PARTIAL
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMinutes: integer("duration_minutes").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  breakEven: integer("break_even").notNull().default(0),
  netPnl: integer("net_pnl").notNull().default(0),
  winRate: integer("win_rate").notNull().default(0),
  ruleViolations: jsonb("rule_violations").notNull().default([]),
  mistakesDetected: jsonb("mistakes_detected").notNull().default([]),
  lessonsGenerated: jsonb("lessons_generated").notNull().default([]),
  coachSummary: text("coach_summary"),
  nextBestActions: jsonb("next_best_actions").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reportIdIdx: uniqueIndex("paper_session_reports_report_id_idx").on(t.sessionReportId),
  sessionFk: foreignKey({ columns: [t.paperSessionId], foreignColumns: [paperSessionsTable.paperSessionId] }).onDelete("cascade"),
  sessionIdx: index("paper_session_reports_session_idx").on(t.paperSessionId),
}));

export type PaperSessionRow = typeof paperSessionsTable.$inferSelect;
export type PaperSessionEventRow = typeof paperSessionEventsTable.$inferSelect;
export type PaperSessionTradeLinkRow = typeof paperSessionTradeLinksTable.$inferSelect;
export type PaperSessionReportRow = typeof paperSessionReportsTable.$inferSelect;
