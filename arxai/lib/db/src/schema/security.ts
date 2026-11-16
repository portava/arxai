import { pgTable, serial, text, boolean, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const securityRolesTable = pgTable("security_roles", {
  id: serial("id").primaryKey(),
  roleKey: text("role_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  isSystemRole: boolean("is_system_role").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const securityPermissionsTable = pgTable("security_permissions", {
  id: serial("id").primaryKey(),
  permissionKey: text("permission_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  isForbidden: boolean("is_forbidden").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const securityRolePermissionsTable = pgTable("security_role_permissions", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull(),
  permissionId: integer("permission_id").notNull(),
  allowed: boolean("allowed").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ roleIdx: index("security_role_permissions_role_idx").on(t.roleId) }));

export const securityUserRolesTable = pgTable("security_user_roles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  roleId: integer("role_id").notNull(),
  assignedBy: text("assigned_by").default("SYSTEM").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ userIdx: index("security_user_roles_user_idx").on(t.userId) }));

export const securityEventsTable = pgTable("security_events", {
  id: serial("id").primaryKey(),
  securityEventId: text("security_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),
  actorUserId: integer("actor_user_id"),
  actorRole: text("actor_role"),
  permissionKey: text("permission_key"),
  route: text("route"),
  method: text("method"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  status: text("status").notNull(),
  message: text("message"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  // ── Phase 4 (additive, nullable): tamper-evident chaining + redaction marker.
  // Populated ONLY for critical events written via recordCriticalSecurityEvent().
  // The hash chain is the subsequence of rows where currentHash IS NOT NULL,
  // ordered by id. Existing inserts leave all of these NULL (no behavior change).
  actorType: text("actor_type"),
  affectedObject: text("affected_object"),
  decisionId: text("decision_id"),
  // App-controlled ISO timestamp included in the hash so verification is
  // deterministic (never relies on the DB-assigned createdAt).
  eventTimestamp: text("event_timestamp"),
  prevHash: text("prev_hash"),
  currentHash: text("current_hash"),
  redactionStatus: text("redaction_status"),
  securityLevel: text("security_level"),
  redactedKeys: jsonb("redacted_keys").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  evtTypeIdx: index("security_events_type_idx").on(t.eventType),
  evtSevIdx: index("security_events_sev_idx").on(t.severity),
  evtCreatedIdx: index("security_events_created_idx").on(t.createdAt),
  evtChainIdx: index("security_events_chain_idx").on(t.currentHash),
}));

export const securityAccessLogsTable = pgTable("security_access_logs", {
  id: serial("id").primaryKey(),
  requestId: text("request_id"),
  userId: integer("user_id"),
  role: text("role"),
  route: text("route").notNull(),
  method: text("method").notNull(),
  statusCode: integer("status_code"),
  permissionRequired: text("permission_required"),
  allowed: boolean("allowed").notNull(),
  reason: text("reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ aclCreatedIdx: index("security_access_logs_created_idx").on(t.createdAt) }));

export const securitySettingsTable = pgTable("security_settings", {
  id: serial("id").primaryKey(),
  authRequired: boolean("auth_required").default(false).notNull(),
  roleSystemEnabled: boolean("role_system_enabled").default(true).notNull(),
  auditLoggingEnabled: boolean("audit_logging_enabled").default(true).notNull(),
  secretRedactionEnabled: boolean("secret_redaction_enabled").default(true).notNull(),
  rateLimitEnabled: boolean("rate_limit_enabled").default(false).notNull(),
  criticalAlertsAlwaysOn: boolean("critical_alerts_always_on").default(true).notNull(),
  paperOnlyEnforced: boolean("paper_only_enforced").default(true).notNull(),
  liveTradingPermanentlyDisabled: boolean("live_trading_permanently_disabled").default(true).notNull(),
  // ── Phase 7 (additive, default-safe): explicit security operational mode.
  // One of 'NORMAL' | 'LOCKDOWN' | 'INCIDENT' (validated in the domain layer).
  // Defaults to NORMAL so existing rows behave exactly as before.
  operationalMode: text("operational_mode").default("NORMAL").notNull(),
  operationalModeReason: text("operational_mode_reason"),
  operationalModeChangedAt: timestamp("operational_mode_changed_at", { withTimezone: true }),
  operationalModeChangedBy: integer("operational_mode_changed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Phase 7: persistent sliding-window rate-limit / cooldown state ───────────
// One row per (action_key, scope_key). scope_key isolates the counter (e.g.
// "user:42", "ip-hash:…", "email-hash:…") so one actor never throttles another.
// The domain `evaluateRateLimit` engine owns the math; this table only persists
// its `RateLimitState` (count / windowStartedAt / blockedUntil) durably so a
// cooldown survives a process restart and is admin-visible.
export const securityCooldownsTable = pgTable("security_cooldowns", {
  id: serial("id").primaryKey(),
  actionKey: text("action_key").notNull(),
  scopeKey: text("scope_key").notNull(),
  count: integer("count").default(0).notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  cooldownScopeUniq: uniqueIndex("security_cooldowns_action_scope_uniq").on(t.actionKey, t.scopeKey),
  cooldownBlockedIdx: index("security_cooldowns_blocked_idx").on(t.blockedUntil),
}));

export const dataProtectionExportsTable = pgTable("data_protection_exports", {
  id: serial("id").primaryKey(),
  exportId: text("export_id").notNull().unique(),
  requestedBy: text("requested_by").default("ADMIN").notNull(),
  exportType: text("export_type").notNull(),
  status: text("status").notNull(),
  redacted: boolean("redacted").default(true).notNull(),
  fileReference: text("file_reference"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
