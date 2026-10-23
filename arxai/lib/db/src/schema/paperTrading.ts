import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (Q) Build Q — Paper Trading Sandbox.
//
// SAFETY: completely isolated from `trades` / `live_positions` / `mt5_*`.
// Paper trading must NEVER call live broker execution; these tables are the
// ONLY persistence surface for sandbox activity.

export const paperAccountsTable = pgTable("paper_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  accountName: text("account_name").notNull().default("Practice"),
  startingBalance: real("starting_balance").notNull().default(10_000),
  currentBalance: real("current_balance").notNull().default(10_000),
  equity: real("equity").notNull().default(10_000),
  marginUsed: real("margin_used").notNull().default(0),
  isActive: integer("is_active").notNull().default(1), // 0/1
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byActive: index("paper_accounts_active_idx").on(t.isActive),
}));
export type PaperAccount = typeof paperAccountsTable.$inferSelect;

export const paperOrdersTable = pgTable("paper_orders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  paperAccountId: integer("paper_account_id").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),       // BUY | SELL
  orderType: text("order_type").notNull().default("MARKET"), // MARKET | LIMIT
  lotSize: real("lot_size").notNull().default(0.01),
  entryPrice: real("entry_price").notNull(),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),
  // OPEN | CLOSED_TP | CLOSED_SL | CLOSED_MANUAL
  status: text("status").notNull().default("OPEN"),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
  exitPrice: real("exit_price"),
  profitLoss: real("profit_loss").notNull().default(0),
  // Source plan / strategy id, advisory only.
  strategyId: text("strategy_id"),
  tradePlanId: integer("trade_plan_id"),
  // (BB) Build AA decision_id this trade was opened against — advisory FK to
  // trade_decision_logs.id. Nullable: trades may be placed without consulting
  // the orchestrator (in which case Build BB still creates a debrief but
  // flags the missing-context warning).
  decisionId: integer("decision_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byAccount: index("paper_orders_account_idx").on(t.paperAccountId),
  byStatus:  index("paper_orders_status_idx").on(t.status),
  byOpened:  index("paper_orders_opened_idx").on(t.openedAt),
}));
export type PaperOrder = typeof paperOrdersTable.$inferSelect;

export const paperTradeEventsTable = pgTable("paper_trade_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  paperOrderId: integer("paper_order_id").notNull(),
  // PLACED | UPDATED | CLOSED_TP | CLOSED_SL | CLOSED_MANUAL | NOTE
  eventType: text("event_type").notNull(),
  message: text("message").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byOrder: index("paper_trade_events_order_idx").on(t.paperOrderId),
}));
export type PaperTradeEvent = typeof paperTradeEventsTable.$inferSelect;
