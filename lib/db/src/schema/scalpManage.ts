import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

// Task #79 — Ruby Flame Scalp Phase 2: failed-flame lockout.
//
// When a flame FAILS on a symbol in a given direction, we park a short-lived,
// per-user lockout so the engine downgrades an otherwise-actionable read on
// THAT same side until the cool-down expires (see scalpManage.isLockoutActive
// + the engine's `recentFailureLockout` input). This is advice-tightening only:
// it never loosens a gate, never closes anything, and is strictly per-user.
//
// One active row per (userId, symbol, direction) — the unique index lets the
// service upsert (refresh expiry + bump repeatCount) on a repeat failure.

export const scalpFlameLockoutsTable = pgTable("scalp_flame_lockouts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // BUY | SELL
  reason: text("reason"),
  repeatCount: integer("repeat_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  userSymbolDirUq: uniqueIndex("scalp_flame_lockouts_user_symbol_dir_uq").on(t.userId, t.symbol, t.direction),
  userExpiresIdx: index("scalp_flame_lockouts_user_expires_idx").on(t.userId, t.expiresAt),
}));

export type ScalpFlameLockout = typeof scalpFlameLockoutsTable.$inferSelect;
export type NewScalpFlameLockout = typeof scalpFlameLockoutsTable.$inferInsert;
