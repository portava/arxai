import {
  pgTable, serial, integer, text, real, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// Build GG — Trading Calendar + AI Performance Command Center.
//
// SAFETY: Reporting / analytics ONLY. Reads from existing AA-FF tables.
// Never places trades, never calls MT5, never enables canPlaceTrades.

export const performanceDailySnapshotsTable = pgTable("performance_daily_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  date: text("date").notNull(),                       // YYYY-MM-DD
  totalTrades: integer("total_trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  breakEven: integer("break_even").notNull().default(0),
  manualCloses: integer("manual_closes").notNull().default(0),
  cancelled: integer("cancelled").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  grossProfit: real("gross_profit").notNull().default(0),
  grossLoss: real("gross_loss").notNull().default(0),
  netPnl: real("net_pnl").notNull().default(0),
  avgWin: real("avg_win").notNull().default(0),
  avgLoss: real("avg_loss").notNull().default(0),
  profitFactor: real("profit_factor").notNull().default(0),
  bestTradeId: integer("best_trade_id"),
  worstTradeId: integer("worst_trade_id"),
  symbolsTraded: jsonb("symbols_traded").notNull().default([]),
  mistakeTags: jsonb("mistake_tags").notNull().default([]),
  topLesson: text("top_lesson").notNull().default(""),
  dayRating: text("day_rating").notNull().default("F"),       // A | B | C | D | F
  dayStatus: text("day_status").notNull().default("NO_TRADE_DAY"), // WINNING_DAY | LOSING_DAY | BREAK_EVEN_DAY | NO_TRADE_DAY
  aiDecisionsCount: integer("ai_decisions_count").notNull().default(0),
  paperTradesOpened: integer("paper_trades_opened").notNull().default(0),
  paperTradesClosed: integer("paper_trades_closed").notNull().default(0),
  debriefsCreated: integer("debriefs_created").notNull().default(0),
  learningEventsCreated: integer("learning_events_created").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Composite uniqueness: each user gets one snapshot per date.
  dateUq: uniqueIndex("perf_daily_snap_date_uq").on(t.date, t.userId),
  dateIdx: index("perf_daily_snap_date_idx").on(t.date),
  userIdx: index("perf_daily_snap_user_id_idx").on(t.userId),
}));

export const performanceSymbolSnapshotsTable = pgTable("performance_symbol_snapshots", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  rangeKey: text("range_key").notNull(),                       // 7d | 30d | 90d | all
  totalTrades: integer("total_trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  netPnl: real("net_pnl").notNull().default(0),
  avgPnl: real("avg_pnl").notNull().default(0),
  bestTradeId: integer("best_trade_id"),
  worstTradeId: integer("worst_trade_id"),
  mistakeTags: jsonb("mistake_tags").notNull().default([]),
  edgeScore: real("edge_score").notNull().default(0),
  learningConfidence: real("learning_confidence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  symbolRangeUq: uniqueIndex("perf_sym_snap_uq").on(t.symbol, t.rangeKey),
}));

export const aiPerformanceSnapshotsTable = pgTable("ai_performance_snapshots", {
  id: serial("id").primaryKey(),
  rangeKey: text("range_key").notNull(),                       // 7d | 30d | 90d | all
  decisionsCreated: integer("decisions_created").notNull().default(0),
  shouldTradeCount: integer("should_trade_count").notNull().default(0),
  holdCount: integer("hold_count").notNull().default(0),
  paperTradesCreated: integer("paper_trades_created").notNull().default(0),
  blockedTrades: integer("blocked_trades").notNull().default(0),
  debriefsCreated: integer("debriefs_created").notNull().default(0),
  learningEventsCreated: integer("learning_events_created").notNull().default(0),
  avgConfidence: real("avg_confidence").notNull().default(0),
  avgRiskScore: real("avg_risk_score").notNull().default(0),
  avgEdgeScore: real("avg_edge_score").notNull().default(0),
  decisionToWinRate: real("decision_to_win_rate").notNull().default(0),
  mostCommonBlocker: text("most_common_blocker").notNull().default(""),
  mostCommonMistake: text("most_common_mistake").notNull().default(""),
  learningSummary: text("learning_summary").notNull().default(""),
  improvementScore: real("improvement_score").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rangeUq: uniqueIndex("ai_perf_snap_range_uq").on(t.rangeKey),
}));

export type PerformanceDailySnapshot = typeof performanceDailySnapshotsTable.$inferSelect;
export type PerformanceSymbolSnapshot = typeof performanceSymbolSnapshotsTable.$inferSelect;
export type AiPerformanceSnapshot = typeof aiPerformanceSnapshotsTable.$inferSelect;
