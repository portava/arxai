import { pgTable, serial, text, real, integer, json, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const backtestsTable = pgTable("backtests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  strategy: text("strategy").notNull(),
  initialBalance: real("initial_balance").notNull(),
  endingBalance: real("ending_balance").notNull().default(0),
  totalTrades: integer("total_trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  profitFactor: real("profit_factor").notNull().default(0),
  maxDrawdown: real("max_drawdown").notNull().default(0),
  bestStrategy: text("best_strategy").notNull().default(""),
  equityCurve: json("equity_curve").$type<number[]>(),
  status: text("status").notNull().default("COMPLETED"), // PENDING, RUNNING, COMPLETED, FAILED
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  userIdx: index("backtests_user_id_idx").on(t.userId),
}));

export const insertBacktestSchema = createInsertSchema(backtestsTable).omit({ id: true, createdAt: true });
export type InsertBacktest = z.infer<typeof insertBacktestSchema>;
export type Backtest = typeof backtestsTable.$inferSelect;
