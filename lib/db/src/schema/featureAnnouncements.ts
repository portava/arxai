import {
  pgTable, serial, text, jsonb, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const featureAnnouncementsTable = pgTable("feature_announcements", {
  id: serial("id").primaryKey(),
  featureKey: text("feature_key").notNull(),
  version: text("version").notNull().default("1"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  route: text("route"),
  severity: text("severity").notNull().default("info"),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyVersionIdx: uniqueIndex("feature_announcements_key_version_idx").on(t.featureKey, t.version),
  activeIdx: index("feature_announcements_active_idx").on(t.active),
}));

export const userFeatureAcknowledgementsTable = pgTable("user_feature_acknowledgements", {
  id: serial("id").primaryKey(),
  userKey: text("user_key").notNull().default("default"),
  featureKey: text("feature_key").notNull(),
  version: text("version").notNull().default("1"),
  acknowledged: boolean("acknowledged").notNull().default(false),
  dismissed: boolean("dismissed").notNull().default(false),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  remindLaterUntil: timestamp("remind_later_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userKeyIdx: uniqueIndex("user_feature_ack_user_key_version_idx").on(t.userKey, t.featureKey, t.version),
}));
