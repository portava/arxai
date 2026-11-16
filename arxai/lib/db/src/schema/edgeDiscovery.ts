import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (W) Build W — AI Edge Discovery Engine.
// Two tables. Read-only analytics over journal + paper trades + debriefs.
// Reports are append-only; the underlying data they cite is not mutated.
// Never references live trade execution / mt5 / safetyCore.

export const edgeDiscoveryReportsTable = pgTable("edge_discovery_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  edgeName: text("edge_name").notNull(),                  // human label e.g. "V75 + BOS strategy"
  symbol:    text("symbol"),
  strategyId: integer("strategy_id"),
  timeframe: text("timeframe"),
  sessionName: text("session_name"),
  marketCondition: text("market_condition"),
  // Stats
  sampleSize:        integer("sample_size").notNull().default(0),
  winRate:           real("win_rate").notNull().default(0),         // 0..1
  averageRr:         real("average_rr").notNull().default(0),
  expectancy:        real("expectancy").notNull().default(0),       // currency per trade
  profitFactor:      real("profit_factor").notNull().default(0),    // gross_win / gross_loss
  // Behavior overlays (averages from debriefs over the same trade set)
  disciplineScoreAvg: real("discipline_score_avg").notNull().default(0),  // 0..100
  executionScoreAvg:  real("execution_score_avg").notNull().default(0),
  emotionalScoreAvg:  real("emotional_score_avg").notNull().default(0),
  // 0..100 — confidence in the edge label (function of sample size + consistency)
  confidenceScore: real("confidence_score").notNull().default(0),
  // STRONG_EDGE | DEVELOPING_EDGE | WEAK_EDGE | NO_EDGE | INSUFFICIENT_DATA
  status: text("status").notNull().default("INSUFFICIENT_DATA"),
  aiSummary: text("ai_summary").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byStatus: index("edge_reports_status_idx").on(t.status),
  byCreated: index("edge_reports_created_idx").on(t.createdAt),
}));
export type EdgeDiscoveryReport = typeof edgeDiscoveryReportsTable.$inferSelect;

export const edgeWarningsTable = pgTable("edge_warnings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  edgeReportId: integer("edge_report_id").notNull(),
  warningType: text("warning_type").notNull(),
  message: text("message").notNull(),
  severity: text("severity").notNull().default("INFO"),  // INFO | WARN | DANGER
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byReport: index("edge_warnings_report_idx").on(t.edgeReportId),
}));
export type EdgeWarning = typeof edgeWarningsTable.$inferSelect;
