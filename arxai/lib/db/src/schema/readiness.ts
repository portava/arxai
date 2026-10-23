import { pgTable, serial, text, integer, jsonb, timestamp, boolean, index, foreignKey } from "drizzle-orm/pg-core";

export const readinessReportsTable = pgTable("readiness_reports", {
  id: serial("id").primaryKey(),
  readinessReportId: text("readiness_report_id").notNull().unique(),
  overallStatus: text("overall_status").notNull(),
  readinessScore: integer("readiness_score").notNull(),
  readinessGrade: text("readiness_grade").notNull(),
  appMode: text("app_mode").default("PAPER_ONLY").notNull(),
  liveTradingStatus: text("live_trading_status").default("DISABLED").notNull(),
  canProceedToPaperTesting: boolean("can_proceed_to_paper_testing").default(false).notNull(),
  canProceedToLiveTrading: boolean("can_proceed_to_live_trading").default(false).notNull(),
  criticalFailures: jsonb("critical_failures").default([]).notNull(),
  warnings: jsonb("warnings").default([]).notNull(),
  subsystemResults: jsonb("subsystem_results").default({}).notNull(),
  workflowResults: jsonb("workflow_results").default({}).notNull(),
  safetyResults: jsonb("safety_results").default({}).notNull(),
  securityResults: jsonb("security_results").default({}).notNull(),
  dataProtectionResults: jsonb("data_protection_results").default({}).notNull(),
  frontendResults: jsonb("frontend_results").default({}).notNull(),
  databaseResults: jsonb("database_results").default({}).notNull(),
  endpointResults: jsonb("endpoint_results").default({}).notNull(),
  recommendedFixes: jsonb("recommended_fixes").default([]).notNull(),
  generatedBy: text("generated_by").default("SYSTEM_READINESS_GATE").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ statusIdx: index("readiness_reports_status_idx").on(t.overallStatus) }));

export const integrationTestRunsTable = pgTable("integration_test_runs", {
  id: serial("id").primaryKey(),
  testRunId: text("test_run_id").notNull().unique(),
  status: text("status").notNull(),
  groupsRun: jsonb("groups_run").default([]).notNull(),
  totalTests: integer("total_tests").default(0).notNull(),
  passed: integer("passed").default(0).notNull(),
  warnings: integer("warnings").default(0).notNull(),
  failed: integer("failed").default(0).notNull(),
  skipped: integer("skipped").default(0).notNull(),
  durationMs: integer("duration_ms").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const integrationTestResultsTable = pgTable("integration_test_results", {
  id: serial("id").primaryKey(),
  testRunId: text("test_run_id").notNull(),
  testId: text("test_id").notNull(),
  testGroup: text("test_group").notNull(),
  testName: text("test_name").notNull(),
  status: text("status").notNull(),
  severity: text("severity").default("INFO").notNull(),
  durationMs: integer("duration_ms").default(0).notNull(),
  details: jsonb("details").default({}).notNull(),
  errors: jsonb("errors").default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  runIdx: index("integration_test_results_run_idx").on(t.testRunId),
  runFk: foreignKey({ columns: [t.testRunId], foreignColumns: [integrationTestRunsTable.testRunId], name: "integration_test_results_run_fk" }).onDelete("cascade"),
}));

export const readinessGateStatusTable = pgTable("readiness_gate_status", {
  id: serial("id").primaryKey(),
  currentStatus: text("current_status").default("UNKNOWN").notNull(),
  readinessScore: integer("readiness_score").default(0).notNull(),
  readinessGrade: text("readiness_grade").default("F").notNull(),
  appMode: text("app_mode").default("PAPER_ONLY").notNull(),
  liveTradingStatus: text("live_trading_status").default("DISABLED").notNull(),
  paperTestingAllowed: boolean("paper_testing_allowed").default(false).notNull(),
  liveTradingAllowed: boolean("live_trading_allowed").default(false).notNull(),
  lastReportId: text("last_report_id"),
  criticalFailureCount: integer("critical_failure_count").default(0).notNull(),
  warningCount: integer("warning_count").default(0).notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  reportFk: foreignKey({ columns: [t.lastReportId], foreignColumns: [readinessReportsTable.readinessReportId], name: "readiness_gate_status_report_fk" }).onDelete("set null"),
}));

export const productionGateLogsTable = pgTable("production_gate_logs", {
  id: serial("id").primaryKey(),
  readinessReportId: text("readiness_report_id"),
  eventType: text("event_type").notNull(),
  severity: text("severity").default("INFO").notNull(),
  message: text("message").notNull(),
  details: jsonb("details").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  reportIdx: index("production_gate_logs_report_idx").on(t.readinessReportId),
  reportFk: foreignKey({ columns: [t.readinessReportId], foreignColumns: [readinessReportsTable.readinessReportId], name: "production_gate_logs_report_fk" }).onDelete("set null"),
}));
