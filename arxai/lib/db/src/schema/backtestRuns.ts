import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (P) Build P — Backtesting & Strategy Validation Engine.
//
// Distinct from the legacy `backtests` table (kept as-is for the existing
// /backtest UI). The new `backtest_runs` table carries the spec-required
// richer schema (per-strategy, per-timeframe, expectancy, profit factor,
// status lifecycle, AI summary), and `backtest_trades` records each simulated
// trade so the UI / scoring engines can introspect outcomes.

export const backtestRunsTable = pgTable("backtest_runs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  strategyId: text("strategy_id").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("M1"),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  initialBalance: real("initial_balance").notNull().default(10_000),
  totalTrades: integer("total_trades").notNull().default(0),
  winningTrades: integer("winning_trades").notNull().default(0),
  losingTrades: integer("losing_trades").notNull().default(0),
  netProfitLoss: real("net_profit_loss").notNull().default(0),
  maxDrawdown: real("max_drawdown").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  averageRr: real("average_rr").notNull().default(0),
  expectancy: real("expectancy").notNull().default(0),
  profitFactor: real("profit_factor").notNull().default(0),
  // PENDING | RUNNING | COMPLETED | FAILED | INSUFFICIENT_DATA
  status: text("status").notNull().default("PENDING"),
  // Which candle series fed the simulation:
  //   "broker"    — real closed bars from the durable broker_candles store
  //   "synthetic" — deterministic generated candles (no broker history)
  // Existing rows predate the broker path, so the default is honest.
  dataSource: text("data_source").notNull().default("synthetic"),
  aiSummary: text("ai_summary"),
  // Verification gate per spec: a run is NOT marked verified unless it has
  // enough trades. Computed at run completion based on totalTrades.
  isVerified: text("is_verified").notNull().default("UNVERIFIED"), // UNVERIFIED | VERIFIED
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCreated:  index("backtest_runs_created_idx").on(t.createdAt),
  byStrategy: index("backtest_runs_strategy_idx").on(t.strategyId),
  bySymbol:   index("backtest_runs_symbol_idx").on(t.symbol),
}));

export type BacktestRun = typeof backtestRunsTable.$inferSelect;

export const backtestTradesTable = pgTable("backtest_trades", {
  id: serial("id").primaryKey(),
  backtestRunId: integer("backtest_run_id").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),                 // BUY | SELL
  entryTime: timestamp("entry_time").notNull(),
  exitTime: timestamp("exit_time").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price").notNull(),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),
  profitLoss: real("profit_loss").notNull(),
  rewardToRisk: real("reward_to_risk").notNull().default(0),
  result: text("result").notNull(),                       // WIN | LOSS | BREAKEVEN | TIMEOUT
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byRun: index("backtest_trades_run_idx").on(t.backtestRunId),
}));

export type BacktestTradeRow = typeof backtestTradesTable.$inferSelect;
