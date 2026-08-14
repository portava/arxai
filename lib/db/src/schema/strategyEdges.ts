import { pgTable, serial, integer, text, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// (CC) Build CC — Per-signal edge memory.
// One row per (symbol, signal_name, action) tracking the rolling outcome
// of trades whose decision relied on this signal. Updated incrementally
// by the learning engine; read by Build AA when composing a future
// decision so prior outcomes can nudge confidence/risk within strict
// boundaries.
//
// SAFETY: bounded adjustments only. Edge memory CANNOT bypass safetyCore
// blockers, kill switch, or live-trade gates. It informs scoring, not
// permission.

export const strategyEdgesTable = pgTable("strategy_edges", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  symbol: text("symbol").notNull(),
  // Strategy/source name (e.g., "strategyEngine", "session", "edge", or a
  // specific strategy ID). Mirrors signalsUsed[].source from AA's payload.
  strategyName: text("strategy_name").notNull().default(""),
  signalName:   text("signal_name").notNull(),
  // BUY | SELL | HOLD — direction of the trade this signal supported.
  action: text("action").notNull(),
  sampleCount:     integer("sample_count").notNull().default(0),
  winCount:        integer("win_count").notNull().default(0),
  lossCount:       integer("loss_count").notNull().default(0),
  breakEvenCount:  integer("break_even_count").notNull().default(0),
  netPnl:  real("net_pnl").notNull().default(0),
  avgPnl:  real("avg_pnl").notNull().default(0),
  // Signed delta to apply to AA's composite confidence when this signal
  // appears in the next decision. Bounded to [-15, 15].
  confidenceAdjustment: real("confidence_adjustment").notNull().default(0),
  // Signed delta to apply to AA's risk score. Bounded to [-15, 15].
  riskAdjustment:       real("risk_adjustment").notNull().default(0),
  // Composite edge score in [-100, 100]. Negative = signal historically
  // costs money on this symbol/direction; positive = historically helps.
  edgeScore:    real("edge_score").notNull().default(0),
  lastResult:   text("last_result").notNull().default(""),  // WIN|LOSS|BREAKEVEN|CANCELLED
  lastTradeId:  integer("last_trade_id"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // One edge row per (symbol, signal, action). Upsert key.
  byCohort:   uniqueIndex("strategy_edges_cohort_uq").on(t.symbol, t.signalName, t.action),
  bySymbol:   index("strategy_edges_symbol_idx").on(t.symbol),
  byUpdated:  index("strategy_edges_updated_idx").on(t.updatedAt),
}));
export type StrategyEdge = typeof strategyEdgesTable.$inferSelect;
