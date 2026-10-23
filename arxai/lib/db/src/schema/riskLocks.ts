import { pgTable, serial, text, boolean, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const RISK_LOCK_TYPES = [
  "FAILURE_STREAK", // wave-4 breaker: >=3 consecutive terminal live failures, 30-min cooling-off
  "USER_MANUAL",
  "DAILY_LOSS_LIMIT",
  "MAX_TRADES_REACHED",
  "CONSECUTIVE_LOSSES",
  "REVENGE_TRADING",
  "OVERTRADE",
  "MARKET_NO_TRADE",
  "WIDE_SPREAD",
  "LOW_LIQUIDITY",
  "STRATEGY_MISMATCH",
  "MISSING_BROKER_AUTH",
  "COOLDOWN_15M",
  "COOLDOWN_30M",
  "COOLDOWN_1H",
  "COOLDOWN_REST_OF_DAY",
] as const;
export type RiskLockType = (typeof RISK_LOCK_TYPES)[number];

export const riskLocksTable = pgTable("risk_locks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  lockType: text("lock_type").notNull(),
  reason: text("reason").notNull(),
  startTime: timestamp("start_time").notNull().defaultNow(),
  endTime: timestamp("end_time"),
  isActive: boolean("is_active").notNull().default(true),
  overrideAllowed: boolean("override_allowed").notNull().default(false),
  relatedTradeId: text("related_trade_id"),
  releasedAt: timestamp("released_at"),
  releasedBy: text("released_by"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  byActive:    index("risk_locks_active_idx").on(t.isActive),
  byEndTime:   index("risk_locks_end_idx").on(t.endTime),
  byLockType:  index("risk_locks_type_idx").on(t.lockType),
  byUser:      index("risk_locks_user_id_idx").on(t.userId),
}));

export const insertRiskLockSchema = createInsertSchema(riskLocksTable).omit({ id: true });
export type InsertRiskLock = z.infer<typeof insertRiskLockSchema>;
export type RiskLockRow = typeof riskLocksTable.$inferSelect;
