import { pgTable, serial, text, real, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const performanceDailyTable = pgTable("performance_daily", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  date: text("date").notNull(), // YYYY-MM-DD
  pnl: real("pnl").notNull().default(0),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  endBalance: real("end_balance").notNull().default(10000),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  userIdx: index("performance_daily_user_id_idx").on(t.userId),
}));

export const insertPerformanceDailySchema = createInsertSchema(performanceDailyTable).omit({ id: true, createdAt: true });
export type InsertPerformanceDaily = z.infer<typeof insertPerformanceDailySchema>;
export type PerformanceDaily = typeof performanceDailyTable.$inferSelect;
