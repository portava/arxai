import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// Phase 3A — Per-user trading sessions. Lightweight session record distinct
// from the heavyweight Build-PP `paper_sessions` table. Each user owns their
// own sessions; nothing is shared. mode is paper|demo|live_locked. live_locked
// is the system default — execution is paper-only until future safety gates.
export const tradingSessionsTable = pgTable("trading_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  mode: text("mode").notNull().default("paper"), // paper|demo|live_locked
  status: text("status").notNull().default("active"), // active|paused|closed
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  linkedMt5ConnectionId: integer("linked_mt5_connection_id"),
  startingBalance: real("starting_balance"),
  endingBalance: real("ending_balance"),
  pnl: real("pnl").default(0),
  winCount: integer("win_count").notNull().default(0),
  lossCount: integer("loss_count").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("trading_sessions_user_id_idx").on(t.userId),
  statusIdx: index("trading_sessions_status_idx").on(t.status),
}));

export type TradingSession = typeof tradingSessionsTable.$inferSelect;
export type InsertTradingSession = typeof tradingSessionsTable.$inferInsert;
