import {
  pgTable, serial, integer, text, real, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// Build EE — Paper Execution Engine.
//
// SAFETY (strict freeze): these tables ONLY persist simulated paper trade
// metadata. They never reference live_positions / mt5_* / executeTrade /
// canPlaceTrades. They map a Build AA decision_id (1-to-1) to a row in the
// existing paper_orders table (Build Q) so EE can:
//   1. Enforce idempotency (unique decisionId)
//   2. Audit eligibility decisions (incl. PAPER_REJECTED with reason)
//   3. Persist the simulated fill / slippage / spread for every paper open
//   4. Snapshot the AA decision + DD market data at fill time (audit only)
//
// EE NEVER writes to paper_accounts.currentBalance directly — that is owned
// by the existing markToMarket() in routes/paperTrading.ts.

export const paperExecutionsTable = pgTable("paper_executions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  executionId: text("execution_id").notNull(),
  // Idempotency key — ONE paper execution per AA decision_id.
  decisionId: integer("decision_id").notNull(),
  // FK-by-convention to existing paper_orders.id; null for PAPER_REJECTED.
  orderId: integer("order_id"),
  symbol: text("symbol").notNull(),
  action: text("action").notNull(), // BUY | SELL | HOLD (HOLD only on rejection)
  // PAPER_OPENED | PAPER_REJECTED | PAPER_PENDING | PAPER_CLOSED_WIN |
  // PAPER_CLOSED_LOSS | PAPER_CLOSED_BREAK_EVEN | PAPER_CLOSED_MANUAL | PAPER_CANCELLED
  status: text("status").notNull(),
  fillType: text("fill_type").notNull().default("SIMULATED_MARKET"),
  executionMode: text("execution_mode").notNull().default("PAPER"),

  entryPriceRequested: real("entry_price_requested"),
  entryPriceFilled:    real("entry_price_filled"),
  stopLoss:            real("stop_loss"),
  takeProfit:          real("take_profit"),
  positionSize:        real("position_size"),
  riskAmount:          real("risk_amount"),
  spreadApplied:       real("spread_applied"),
  slippageApplied:     real("slippage_applied"),

  confidence: real("confidence"),
  riskScore:  real("risk_score"),

  rejectionReason: text("rejection_reason"),
  warnings: jsonb("warnings").notNull().default([]),

  marketDataSnapshot: jsonb("market_data_snapshot").notNull().default({}),
  decisionSnapshot:   jsonb("decision_snapshot").notNull().default({}),
  executionSnapshot:  jsonb("execution_snapshot").notNull().default({}),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Idempotency guard — one paper execution per AA decision.
  byDecision: uniqueIndex("paper_executions_decision_uniq").on(t.decisionId),
  byExecution: uniqueIndex("paper_executions_execution_uniq").on(t.executionId),
  byOrder:  index("paper_executions_order_idx").on(t.orderId),
  bySymbol: index("paper_executions_symbol_idx").on(t.symbol),
  byStatus: index("paper_executions_status_idx").on(t.status),
}));
export type PaperExecution = typeof paperExecutionsTable.$inferSelect;

export const paperExecutionLogsTable = pgTable("paper_execution_logs", {
  id: serial("id").primaryKey(),
  executionId: text("execution_id"),
  decisionId:  integer("decision_id"),
  orderId:     integer("order_id"),
  symbol:      text("symbol"),
  action:      text("action"),
  status:      text("status").notNull(),
  message:     text("message").notNull().default(""),
  details:     jsonb("details").notNull().default({}),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byExecution: index("paper_execution_logs_execution_idx").on(t.executionId),
  byDecision:  index("paper_execution_logs_decision_idx").on(t.decisionId),
  byCreatedAt: index("paper_execution_logs_created_idx").on(t.createdAt),
}));
export type PaperExecutionLog = typeof paperExecutionLogsTable.$inferSelect;
