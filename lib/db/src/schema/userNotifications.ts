// Phase 10A/10B/10C/10D — Per-user notifications, preferences, push subs, activity timeline.
// Additive tables. Distinct names from legacy notifications/alerts.
import { pgTable, serial, integer, text, boolean, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

// 10A — Notifications
export const userNotificationsTable = pgTable("user_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  notificationType: text("notification_type").notNull(),
  severity: text("severity").notNull().default("info"), // info|warning|critical
  title: text("title").notNull(),
  message: text("message").notNull().default(""),
  source: text("source").notNull().default("system"),
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  status: text("status").notNull().default("unread"), // unread|read|dismissed
  actionLabel: text("action_label"),
  actionTarget: text("action_target"),
  // T024 — collapse repeated alerts instead of spawning a new row each emission.
  // repeatCount counts how many times the same deduped condition re-fired;
  // lastOccurrenceAt is the most-recent re-fire time (createdAt stays the first).
  repeatCount: integer("repeat_count").notNull().default(1),
  lastOccurrenceAt: timestamp("last_occurrence_at"),
  deliveredInApp: boolean("delivered_in_app").notNull().default(true),
  deliveredPush: boolean("delivered_push").notNull().default(false),
  pushAttemptedAt: timestamp("push_attempted_at"),
  pushDeliveredAt: timestamp("push_delivered_at"),
  readAt: timestamp("read_at"),
  dismissedAt: timestamp("dismissed_at"),
  // bucket = unix-hour for race-safe dedupe per (user,type,entity,bucket)
  bucket: integer("bucket").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("user_notifications_user_idx").on(t.userId),
  statusIdx: index("user_notifications_status_idx").on(t.status),
  typeIdx: index("user_notifications_type_idx").on(t.notificationType),
  dedupe: uniqueIndex("user_notifications_dedupe_uniq").on(t.userId, t.notificationType, t.entityType, t.entityId, t.bucket),
}));
export type UserNotification = typeof userNotificationsTable.$inferSelect;

// 10B — Preferences (one row per user)
export const userNotificationPreferencesTable = pgTable("user_notification_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(false),
  emailEnabled: boolean("email_enabled").default(false),
  mt5StatusEnabled: boolean("mt5_status_enabled").notNull().default(true),
  riskAlertsEnabled: boolean("risk_alerts_enabled").notNull().default(true),
  tradeEventsEnabled: boolean("trade_events_enabled").notNull().default(true),
  aiCoachingEnabled: boolean("ai_coaching_enabled").notNull().default(true),
  playbookChecklistEnabled: boolean("playbook_checklist_enabled").notNull().default(true),
  journalRemindersEnabled: boolean("journal_reminders_enabled").notNull().default(true),
  sessionRemindersEnabled: boolean("session_reminders_enabled").notNull().default(true),
  securityAlertsEnabled: boolean("security_alerts_enabled").notNull().default(true),
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  quietHoursStart: text("quiet_hours_start"), // "22:00"
  quietHoursEnd: text("quiet_hours_end"),
  timezone: text("timezone"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userUniq: uniqueIndex("user_notification_prefs_user_uniq").on(t.userId),
}));
export type UserNotificationPreferences = typeof userNotificationPreferencesTable.$inferSelect;

// 10C — Push subscriptions
export const userPushSubscriptionsTable = pgTable("user_push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  endpointHash: text("endpoint_hash").notNull(),
  subscriptionJson: text("subscription_json").notNull(), // raw JSON; never returned to other users
  userAgent: text("user_agent"),
  deviceLabel: text("device_label"),
  status: text("status").notNull().default("active"), // active|revoked|failed
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
}, (t) => ({
  userIdx: index("user_push_subscriptions_user_idx").on(t.userId),
  endpointUniq: uniqueIndex("user_push_subscriptions_endpoint_uniq").on(t.userId, t.endpointHash),
}));
export type UserPushSubscription = typeof userPushSubscriptionsTable.$inferSelect;

// 10D — Activity timeline
export const userActivityTimelineTable = pgTable("user_activity_timeline", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  source: text("source").notNull().default("system"),
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("user_activity_user_idx").on(t.userId),
  typeIdx: index("user_activity_type_idx").on(t.eventType),
  createdIdx: index("user_activity_created_idx").on(t.createdAt),
}));
export type UserActivityTimelineEvent = typeof userActivityTimelineTable.$inferSelect;
