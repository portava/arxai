// Phase 5A — Per-user paper trade lifecycle. NEW table dedicated to the
// user-safe paper trading flow described in the Phase 5 spec. Distinct from
// legacy `trades`, `paper_orders` (Build Q), and `paper_executions` (Build EE).
// SAFETY: this table never reaches a real broker — paper-only persistence.
import { pgTable, serial, integer, text, real, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const paperTradesTable = pgTable("paper_trades", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradingSessionId: integer("trading_session_id"),
  mt5ConnectionId: integer("mt5_connection_id"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),                  // buy|sell
  status: text("status").notNull().default("planned"), // planned|open|closed|cancelled|failed
  entryType: text("entry_type").notNull().default("market"), // market|limit|stop|manual
  plannedEntryPrice: real("planned_entry_price"),
  entryPrice: real("entry_price"),
  exitPrice: real("exit_price"),
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  lotSize: real("lot_size").notNull(),
  riskAmount: real("risk_amount"),
  riskPercent: real("risk_percent"),
  rewardRiskRatio: real("reward_risk_ratio"),
  pnl: real("pnl"),
  pnlPercent: real("pnl_percent"),
  openedAt: timestamp("opened_at"),
  closedAt: timestamp("closed_at"),
  cancelledAt: timestamp("cancelled_at"),
  strategyTag: text("strategy_tag"),
  setupGrade: text("setup_grade"),               // A|B|C|D
  aiConfidence: real("ai_confidence"),
  reasonForEntry: text("reason_for_entry"),
  reasonForExit: text("reason_for_exit"),
  mistakeTags: jsonb("mistake_tags").$type<string[]>().default([]),
  screenshotUrl: text("screenshot_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("paper_trades_user_id_idx").on(t.userId),
  sessionIdx: index("paper_trades_session_idx").on(t.tradingSessionId),
  statusIdx: index("paper_trades_status_idx").on(t.status),
  closedIdx: index("paper_trades_closed_at_idx").on(t.closedAt),
}));

export type PaperTrade = typeof paperTradesTable.$inferSelect;
export type InsertPaperTrade = typeof paperTradesTable.$inferInsert;
