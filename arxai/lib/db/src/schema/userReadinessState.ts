// Per-user Trading Readiness state.
//
// SAFETY: All tables additive. No secret columns. liveAdminApproved is ONE
// of many gates — by itself it does NOT enable live trading. Live still
// requires disclosure + verified live routing + explicit user confirm +
// Risk Governor pass + the system-wide PAPER_ONLY hard-lock to be lifted.

import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";

export type AccountRoutingMode = "USER_OWNED_MT5" | "SHARED_MASTER_MT5";

export const userReadinessStateTable = pgTable("user_readiness_state", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  accountMode: text("account_mode"),                       // USER_OWNED_MT5 | SHARED_MASTER_MT5 | null
  profileComplete: boolean("profile_complete").notNull().default(false),
  riskProfileComplete: boolean("risk_profile_complete").notNull().default(false),
  tradingDisclaimerAcceptedAt: timestamp("trading_disclaimer_accepted_at", { withTimezone: true }),
  liveDisclosureAcceptedAt: timestamp("live_disclosure_accepted_at", { withTimezone: true }),
  liveDisclosureVersion: text("live_disclosure_version"),
  sharedMasterDisclosureAcceptedAt: timestamp("shared_master_disclosure_accepted_at", { withTimezone: true }),
  liveAdminApproved: boolean("live_admin_approved").notNull().default(false),
  liveAdminApprovedAt: timestamp("live_admin_approved_at", { withTimezone: true }),
  liveAdminApprovedBy: integer("live_admin_approved_by"),
  liveAdminRevokedAt: timestamp("live_admin_revoked_at", { withTimezone: true }),
  liveAdminRevokeReason: text("live_admin_revoke_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: uniqueIndex("user_readiness_state_user_idx").on(t.userId),
}));
export type UserReadinessState = typeof userReadinessStateTable.$inferSelect;

export const userLiveDisclosureAcceptancesTable = pgTable("user_live_disclosure_acceptances", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  disclosureType: text("disclosure_type").notNull(),      // LIVE_TRADING | SHARED_MASTER | TRADING_RISK
  version: text("version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  contentHash: text("content_hash"),
}, (t) => ({
  byUser: index("user_live_disclosure_acc_user_idx").on(t.userId),
}));
export type UserLiveDisclosureAcceptance = typeof userLiveDisclosureAcceptancesTable.$inferSelect;

export const userReadinessAuditTable = pgTable("user_readiness_audit", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  actorUserId: integer("actor_user_id"),
  action: text("action").notNull(),                       // SET_ACCOUNT_MODE | ACCEPT_DISCLOSURE | APPROVE_LIVE | REVOKE_LIVE
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index("user_readiness_audit_user_idx").on(t.userId),
  byCreated: index("user_readiness_audit_created_idx").on(t.createdAt),
}));
export type UserReadinessAuditRow = typeof userReadinessAuditTable.$inferSelect;
