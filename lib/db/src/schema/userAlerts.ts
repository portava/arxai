// Phase 9E — Per-user dashboard alerts.
// Additive table (distinct from legacy alerts/notifications).
import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const userAlertsTable = pgTable("user_alerts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  alertType: text("alert_type").notNull(), // mt5_disconnected|mt5_stale|risk_block|cooldown_started|daily_loss_warning|session_no_journal|trade_no_review|playbook_missing|checklist_failed|coaching_updated
  // bucket = unix-hour timestamp, used for idempotent upsert (one alert per user+type+hour).
  bucket: integer("bucket").notNull().default(0),
  severity: text("severity").notNull().default("info"), // info|warning|critical
  title: text("title").notNull(),
  message: text("message").notNull().default(""),
  source: text("source").notNull().default("system"), // mt5|risk|ai|session|playbook|calendar|system
  status: text("status").notNull().default("unread"), // unread|read|dismissed
  actionLabel: text("action_label"),
  actionTarget: text("action_target"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  readAt: timestamp("read_at"),
  dismissedAt: timestamp("dismissed_at"),
}, (t) => ({
  userIdx: index("user_alerts_user_idx").on(t.userId),
  statusIdx: index("user_alerts_status_idx").on(t.status),
  // Phase 9 idempotency — strict per (user, type, hourly bucket).
  uniqBucket: uniqueIndex("user_alerts_user_type_bucket_uniq").on(t.userId, t.alertType, t.bucket),
}));
export type UserAlert = typeof userAlertsTable.$inferSelect;
export type InsertUserAlert = typeof userAlertsTable.$inferInsert;
