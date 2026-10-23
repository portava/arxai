// Build LL — Notification Center + Safety Alerts schema.
//
// SAFETY: All tables additive. NO trade execution columns. NO live-trading
// flags. NO secret columns. Notifications are alerts/warnings only.

import { pgTable, serial, text, integer, jsonb, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column. NULL = system-wide.
  notificationId: text("notification_id").notNull(),
  type: text("type").notNull(),                  // SAFETY|RISK|TRADE|LEARNING|SYSTEM|COACH|DATA|REPLAY|BROKER
  severity: text("severity").notNull(),          // INFO|WARNING|HIGH|CRITICAL
  status: text("status").notNull().default("UNREAD"), // UNREAD|READ|ACKNOWLEDGED|DISMISSED|SNOOZED
  title: text("title").notNull(),
  message: text("message").notNull(),
  sourceBuild: text("source_build").notNull(),   // AA..LL
  sourceEventId: text("source_event_id"),
  symbol: text("symbol"),
  relatedTradeId: text("related_trade_id"),
  relatedDecisionId: text("related_decision_id"),
  relatedDebriefId: text("related_debrief_id"),
  relatedLearningEventId: text("related_learning_event_id"),
  relatedReplayRunId: text("related_replay_run_id"),
  actionRequired: boolean("action_required").notNull().default(false),
  recommendedAction: text("recommended_action"),
  actionUrl: text("action_url"),
  metadata: jsonb("metadata").notNull().default({}),
  dedupeKey: text("dedupe_key").notNull(),
  repeatCount: integer("repeat_count").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  notifIdIdx: uniqueIndex("notifications_notification_id_idx").on(t.notificationId),
  dedupeIdx: uniqueIndex("notifications_dedupe_key_idx").on(t.dedupeKey),
  statusIdx: index("notifications_status_idx").on(t.status),
  severityIdx: index("notifications_severity_idx").on(t.severity),
  createdAtIdx: index("notifications_created_at_idx").on(t.createdAt),
  userIdIdx: index("notifications_user_id_idx").on(t.userId),
  // Composite indexes for the two hottest per-user read paths: the unread
  // badge count (user + status) and the notification feed (user + recency).
  userStatusIdx: index("notifications_user_status_idx").on(t.userId, t.status),
  userCreatedIdx: index("notifications_user_created_at_idx").on(t.userId, t.createdAt),
}));

export const notificationPreferencesTable = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  safetyAlertsEnabled: boolean("safety_alerts_enabled").notNull().default(true),
  tradeAlertsEnabled: boolean("trade_alerts_enabled").notNull().default(true),
  learningAlertsEnabled: boolean("learning_alerts_enabled").notNull().default(true),
  coachAlertsEnabled: boolean("coach_alerts_enabled").notNull().default(true),
  replayAlertsEnabled: boolean("replay_alerts_enabled").notNull().default(true),
  dataAlertsEnabled: boolean("data_alerts_enabled").notNull().default(true),
  brokerAlertsEnabled: boolean("broker_alerts_enabled").notNull().default(true),
  criticalAlertsAlwaysOn: boolean("critical_alerts_always_on").notNull().default(true),
  // (Unified Alerts QA-fix) Minimum severity that triggers a push delivery.
  // info | warning | critical. CRITICAL alerts still bypass this gate when
  // the firing call sets bypassPreference (e.g. live-risk emergencies).
  minimumPushSeverity: text("minimum_push_severity").notNull().default("info"),
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  digestFrequency: text("digest_frequency").notNull().default("DAILY"),
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationLogsTable = pgTable("notification_logs", {
  id: serial("id").primaryKey(),
  notificationId: text("notification_id"),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  evtCreatedIdx: index("notification_logs_created_at_idx").on(t.createdAt),
}));

export const notificationDigestsTable = pgTable("notification_digests", {
  id: serial("id").primaryKey(),
  digestId: text("digest_id").notNull(),
  rangeStart: timestamp("range_start", { withTimezone: true }).notNull(),
  rangeEnd: timestamp("range_end", { withTimezone: true }).notNull(),
  totalNotifications: integer("total_notifications").notNull().default(0),
  criticalCount: integer("critical_count").notNull().default(0),
  warningCount: integer("warning_count").notNull().default(0),
  tradeCount: integer("trade_count").notNull().default(0),
  learningCount: integer("learning_count").notNull().default(0),
  safetyCount: integer("safety_count").notNull().default(0),
  summary: jsonb("summary").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  digestIdIdx: uniqueIndex("notification_digests_digest_id_idx").on(t.digestId),
}));
