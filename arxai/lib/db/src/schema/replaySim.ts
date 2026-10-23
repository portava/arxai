// Build JJ — Replay Simulator + Strategy Lab.
//
// SAFETY (strict freeze): REPLAY_ONLY / PAPER_SIMULATION mode. NEVER places
// live trades, NEVER calls MT5, NEVER enables canPlaceTrades, NEVER touches
// EE paper_orders or HH risk-governor live state. All replay trades are
// stored in a SEPARATE table (replay_trades) — never in paper_orders.

import { pgTable, serial, text, integer, real, jsonb, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

export const replayScenariosTable = pgTable("replay_scenarios", {
  id: serial("id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  title: text("title").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("M5"),
  source: text("source").notNull().default("SYNTHETIC"),
  marketCondition: text("market_condition").notNull().default("RANGING"),
  candles: jsonb("candles").notNull().default([]),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scenarioIdUq: uniqueIndex("replay_scenarios_id_uq").on(t.scenarioId),
  symbolIdx: index("replay_scenarios_symbol_idx").on(t.symbol),
}));

export const replayRunsTable = pgTable("replay_runs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  replayRunId: text("replay_run_id").notNull(),
  scenarioId: text("scenario_id").notNull(),
  mode: text("mode").notNull().default("REPLAY_ONLY"),
  status: text("status").notNull().default("COMPLETED"),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("M5"),
  candlesProcessed: integer("candles_processed").notNull().default(0),
  decisionsCreated: integer("decisions_created").notNull().default(0),
  simulatedTradesOpened: integer("simulated_trades_opened").notNull().default(0),
  simulatedTradesClosed: integer("simulated_trades_closed").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  breakEven: integer("break_even").notNull().default(0),
  netPnl: real("net_pnl").notNull().default(0),
  maxDrawdown: real("max_drawdown").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  profitFactor: real("profit_factor").notNull().default(0),
  replaySummary: jsonb("replay_summary").notNull().default({}),
  warnings: jsonb("warnings").notNull().default([]),
  errors: jsonb("errors").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdUq: uniqueIndex("replay_runs_id_uq").on(t.replayRunId),
  createdIdx: index("replay_runs_created_idx").on(t.createdAt),
  scenarioIdx: index("replay_runs_scenario_idx").on(t.scenarioId),
}));

export const replayTradesTable = pgTable("replay_trades", {
  id: serial("id").primaryKey(),
  replayTradeId: text("replay_trade_id").notNull(),
  replayRunId: text("replay_run_id").notNull(),
  decisionId: text("decision_id").notNull().default(""),
  playbookEntryId: text("playbook_entry_id").notNull().default(""),
  symbol: text("symbol").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull().default("OPEN"),
  entryPrice: real("entry_price").notNull().default(0),
  exitPrice: real("exit_price").notNull().default(0),
  stopLoss: real("stop_loss").notNull().default(0),
  takeProfit: real("take_profit").notNull().default(0),
  positionSize: real("position_size").notNull().default(1),
  pnl: real("pnl").notNull().default(0),
  pnlPercent: real("pnl_percent").notNull().default(0),
  result: text("result").notNull().default("OPEN"),
  openedAtReplayTime: timestamp("opened_at_replay_time", { withTimezone: true }),
  closedAtReplayTime: timestamp("closed_at_replay_time", { withTimezone: true }),
  candleOpenedIndex: integer("candle_opened_index").notNull().default(-1),
  candleClosedIndex: integer("candle_closed_index").notNull().default(-1),
  closeReason: text("close_reason").notNull().default(""),
  decisionSnapshot: jsonb("decision_snapshot").notNull().default({}),
  marketSnapshot: jsonb("market_snapshot").notNull().default({}),
  sniperSnapshot: jsonb("sniper_snapshot").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tradeIdUq: uniqueIndex("replay_trades_id_uq").on(t.replayTradeId),
  runIdx: index("replay_trades_run_idx").on(t.replayRunId),
}));

export const strategyLabExperimentsTable = pgTable("strategy_lab_experiments", {
  id: serial("id").primaryKey(),
  experimentId: text("experiment_id").notNull(),
  title: text("title").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("M5"),
  playbookEntryId: text("playbook_entry_id").notNull().default(""),
  scenarioIds: jsonb("scenario_ids").notNull().default([]),
  settings: jsonb("settings").notNull().default({}),
  resultSummary: jsonb("result_summary").notNull().default({}),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  experimentIdUq: uniqueIndex("strategy_lab_experiments_id_uq").on(t.experimentId),
  createdIdx: index("strategy_lab_experiments_created_idx").on(t.createdAt),
}));

export const replayReportsTable = pgTable("replay_reports", {
  id: serial("id").primaryKey(),
  replayReportId: text("replay_report_id").notNull(),
  replayRunId: text("replay_run_id").notNull(),
  scenarioId: text("scenario_id").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("M5"),
  totalTrades: integer("total_trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  breakEven: integer("break_even").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  netPnl: real("net_pnl").notNull().default(0),
  maxDrawdown: real("max_drawdown").notNull().default(0),
  profitFactor: real("profit_factor").notNull().default(0),
  avgWin: real("avg_win").notNull().default(0),
  avgLoss: real("avg_loss").notNull().default(0),
  bestSetup: text("best_setup").notNull().default(""),
  weakestSetup: text("weakest_setup").notNull().default(""),
  mistakePatterns: jsonb("mistake_patterns").notNull().default([]),
  playbookRecommendations: jsonb("playbook_recommendations").notNull().default([]),
  coachNotes: jsonb("coach_notes").notNull().default([]),
  safetyNotes: jsonb("safety_notes").notNull().default([]),
  shouldPromoteToPlaybook: boolean("should_promote_to_playbook").notNull().default(false),
  shouldMarkForReview: boolean("should_mark_for_review").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reportIdUq: uniqueIndex("replay_reports_id_uq").on(t.replayReportId),
  runIdx: index("replay_reports_run_idx").on(t.replayRunId),
}));

export const replayLogsTable = pgTable("replay_logs", {
  id: serial("id").primaryKey(),
  replayRunId: text("replay_run_id").notNull().default(""),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("INFO"),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index("replay_logs_run_idx").on(t.replayRunId),
  createdIdx: index("replay_logs_created_idx").on(t.createdAt),
}));
