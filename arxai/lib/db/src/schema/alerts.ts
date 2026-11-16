import { pgTable, serial, text, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";

// alertsTable — extended ADDITIVELY for Build L. All new columns are nullable
// (or have defaults) so existing inserts in tradeManagement.ts and mt5.ts that
// pass only {type, severity, title, message, symbol} continue to work.
export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),                           // (L) for future multi-user
  type: text("type").notNull(),
  priority: text("priority").notNull().default("MEDIUM"), // (L) LOW | MEDIUM | HIGH | CRITICAL
  severity: text("severity").notNull().default("info"),   // existing: info | warning | danger | success
  title: text("title").notNull(),
  message: text("message").notNull(),
  symbol: text("symbol"),
  relatedTradeId: integer("related_trade_id"),          // (L)
  relatedPositionId: integer("related_position_id"),    // (L)
  relatedTradePlanId: integer("related_trade_plan_id"), // (L)
  actionRequired: boolean("action_required").notNull().default(false), // (L)
  dedupeKey: text("dedupe_key"),                        // (L) hash key for in-window dedupe
  read: integer("read").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  byCreatedAt: index("alerts_created_at_idx").on(t.createdAt),
  byRead:      index("alerts_read_idx").on(t.read),
  byDedupe:    index("alerts_dedupe_idx").on(t.dedupeKey),
}));

// Per-type on/off (existing — preserved for back-compat with /alerts/settings).
export const alertSettingsTable = pgTable("alert_settings", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().unique(),
  enabled: integer("enabled").notNull().default(1),
});

// (L) Broader user preferences with category toggles + quiet hours.
// Singleton row enforced by application logic (id=1) for the MVP.
export const alertPreferencesTable = pgTable("alert_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  marketAlertsEnabled:        boolean("market_alerts_enabled").notNull().default(true),
  riskAlertsEnabled:          boolean("risk_alerts_enabled").notNull().default(true),
  brokerAlertsEnabled:        boolean("broker_alerts_enabled").notNull().default(true),
  positionAlertsEnabled:      boolean("position_alerts_enabled").notNull().default(true),
  coachAlertsEnabled:         boolean("coach_alerts_enabled").notNull().default(true),
  weeklyReviewAlertsEnabled:  boolean("weekly_review_alerts_enabled").notNull().default(true),
  tradePlanAlertsEnabled:     boolean("trade_plan_alerts_enabled").notNull().default(true),
  executionSafetyAlertsEnabled: boolean("execution_safety_alerts_enabled").notNull().default(true),
  quietHoursStart: integer("quiet_hours_start"), // 0..23 local hour, null = no quiet hours
  quietHoursEnd:   integer("quiet_hours_end"),   // 0..23
  // (Unified Alerts QA-fix) Minimum severity that may trigger a push delivery.
  // info  → all severities push (default)
  // warning → only warning+critical push
  // critical → only critical push
  // CRITICAL alerts STILL bypass quiet hours and category toggles by
  // separate inviolable contract in alertManager.ts.
  minimumPushSeverity: text("minimum_push_severity").notNull().default("info"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// (Unified Alerts QA-fix) Per-delivery audit row for push/in-app dispatch.
// Append-only. Lets admin "Alert Health" surface real success/fail/revoked
// counts and operators investigate why a specific user didn't receive a push.
// NEVER stores tokens, endpoints, or VAPID keys — only the channel and the
// terminal status. failureReason is a short coded string (e.g. "vapid_not_configured",
// "push_disabled_by_user", "below_min_severity", "no_active_subscription",
// "endpoint_gone", "send_error_500"), never an upstream error body.
export const alertDeliveryLogsTable = pgTable("alert_delivery_logs", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id"),               // optional FK; null when alert system fired without a row
  userId: integer("user_id").notNull(),
  deliveryChannel: text("delivery_channel").notNull(), // in_app | push
  deliveryStatus: text("delivery_status").notNull(),   // delivered | failed | revoked | skipped
  failureReason: text("failure_reason"),               // short code, no upstream payload
  severity: text("severity"),                          // info | warning | critical
  category: text("category"),                          // notification type / source
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byUser: index("alert_delivery_logs_user_idx").on(t.userId),
  byCreatedAt: index("alert_delivery_logs_created_at_idx").on(t.createdAt),
  byChannelStatus: index("alert_delivery_logs_channel_status_idx").on(t.deliveryChannel, t.deliveryStatus),
}));

export type Alert = typeof alertsTable.$inferSelect;
export type AlertSettings = typeof alertSettingsTable.$inferSelect;
export type AlertPreferences = typeof alertPreferencesTable.$inferSelect;
export type AlertDeliveryLog = typeof alertDeliveryLogsTable.$inferSelect;
