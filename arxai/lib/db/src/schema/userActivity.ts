// Phase 13 — User activity heartbeat for Protective Auto-Close.
//
// SAFETY:
//   * Bumped by POST /me/activity-ping only (authenticated, per-user).
//   * Engine reads this to decide INACTIVE vs UNKNOWN. When NULL or stale
//     beyond ARX_ACTIVITY_UNKNOWN_GRACE_MS, status="UNKNOWN" and the
//     decision engine downgrades to ALERT_ONLY — never auto-closes on
//     unknown activity.

import { pgTable, integer, timestamp } from "drizzle-orm/pg-core";

export const userActivityTable = pgTable("user_activity", {
  userId: integer("user_id").primaryKey(),
  lastActiveAt: timestamp("last_active_at"),
  lastTradeInteractionAt: timestamp("last_trade_interaction_at"),
  lastAiInteractionAt: timestamp("last_ai_interaction_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserActivity = typeof userActivityTable.$inferSelect;
