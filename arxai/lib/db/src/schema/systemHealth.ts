// Build MM — System Health, Audit, and Admin Control Center schema.
//
// SAFETY: All tables additive. NO trade execution columns. NO live-trading
// flags. NO secret columns. Health/audit/admin records are diagnostics only.

import { pgTable, serial, text, jsonb, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const systemHealthChecksTable = pgTable("system_health_checks", {
  id: serial("id").primaryKey(),
  healthCheckId: text("health_check_id").notNull(),
  overallStatus: text("overall_status").notNull(),       // HEALTHY|DEGRADED|UNSAFE|FAILED
  liveTradingStatus: text("live_trading_status").notNull().default("DISABLED"),
  mode: text("mode").notNull().default("PAPER_ONLY"),
  subsystemStatus: jsonb("subsystem_status").notNull().default({}),
  databaseStatus: jsonb("database_status").notNull().default({}),
  endpointStatus: jsonb("endpoint_status").notNull().default({}),
  safetyStatus: jsonb("safety_status").notNull().default({}),
  secretSafetyStatus: jsonb("secret_safety_status").notNull().default({}),
  performanceStatus: jsonb("performance_status").notNull().default({}),
  recommendedAdminActions: jsonb("recommended_admin_actions").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  errors: jsonb("errors").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  healthCheckIdIdx: uniqueIndex("system_health_checks_id_idx").on(t.healthCheckId),
  createdAtIdx: index("system_health_checks_created_at_idx").on(t.createdAt),
}));

export const systemAuditLogsTable = pgTable("system_audit_logs", {
  id: serial("id").primaryKey(),
  auditId: text("audit_id").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),                  // INFO|WARNING|HIGH|CRITICAL
  sourceBuild: text("source_build").notNull(),           // AA..MM
  sourceService: text("source_service").notNull(),
  actor: text("actor").notNull().default("SYSTEM"),      // SYSTEM|ADMIN|USER
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot"),
  metadata: jsonb("metadata").notNull().default({}),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  auditIdIdx: uniqueIndex("system_audit_logs_audit_id_idx").on(t.auditId),
  severityIdx: index("system_audit_logs_severity_idx").on(t.severity),
  buildIdx: index("system_audit_logs_source_build_idx").on(t.sourceBuild),
  createdAtIdx: index("system_audit_logs_created_at_idx").on(t.createdAt),
}));

export const adminActionLogsTable = pgTable("admin_action_logs", {
  id: serial("id").primaryKey(),
  adminActionId: text("admin_action_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(),                      // ACCEPTED|REJECTED|FAILED|COMPLETED
  severity: text("severity").notNull().default("INFO"),
  requestedBy: text("requested_by").notNull().default("ADMIN"),
  reason: text("reason"),
  result: jsonb("result").notNull().default({}),
  auditId: text("audit_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actionIdIdx: uniqueIndex("admin_action_logs_action_id_idx").on(t.adminActionId),
  createdAtIdx: index("admin_action_logs_created_at_idx").on(t.createdAt),
}));

export const systemConfigRegistryTable = pgTable("system_config_registry", {
  id: serial("id").primaryKey(),
  appMode: text("app_mode").notNull().default("PAPER_ONLY"),
  liveTradingEnabled: boolean("live_trading_enabled").notNull().default(false),
  brokerMode: text("broker_mode").notNull().default("READ_ONLY"),
  marketDataMode: text("market_data_mode").notNull().default("read_only"),
  paperAutopilotEnabled: boolean("paper_autopilot_enabled").notNull().default(false),
  notificationCriticalAlwaysOn: boolean("notification_critical_always_on").notNull().default(true),
  replayOnlyMode: boolean("replay_only_mode").notNull().default(true),
  dataImportEnabled: boolean("data_import_enabled").notNull().default(true),
  secretRedactionEnabled: boolean("secret_redaction_enabled").notNull().default(true),
  currentSafetyLock: text("current_safety_lock"),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
