// ── Admin Cockpit (Task #752) — control-room audit, alerts, and notes ───────
//
// SAFETY (inviolable):
// - These tables back the admin/owner-only Admin Cockpit. They are pure
//   READ-aggregation + operator-control evidence. NOTHING here is an execution
//   path: no row in these tables can place, size, arm, or gate a trade.
// - admin_cockpit_audit_log is APPEND-ONLY. Every cockpit-originated mutation
//   writes one row here IN ADDITION TO the existing canonical admin audit
//   (admin_action_audit_log / master_live_access_audit). It records that the
//   action was initiated FROM the cockpit; it never replaces the real audit.
// - admin_cockpit_alerts is a derived/operator surface (risk anomalies, bridge
//   offline, exposure breaches). status lifecycle: ACTIVE → ACKNOWLEDGED →
//   RESOLVED. Dedupe is by (alert_type, target_user_id) while ACTIVE.
// - admin_cockpit_notes are free-text operator annotations on a trader /
//   investor / global target. Never user-facing.

import {
  pgTable, serial, text, integer, jsonb, boolean,
  timestamp, index,
} from "drizzle-orm/pg-core";

// ─── 1. Append-only cockpit audit log ───────────────────────────────────────
// Records that a mutation was INITIATED from the Admin Cockpit. The canonical
// audit row (admin_action_audit_log / master_live_access_audit) is still written
// by the delegated handler; this row is the cockpit-scoped mirror so the cockpit
// timeline is self-contained and tamper-evident.
export const adminCockpitAuditLogTable = pgTable("admin_cockpit_audit_log", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id"),
  adminRole: text("admin_role").notNull(),
  // The cockpit action verb, e.g. COCKPIT_APPROVE_TRADER, COCKPIT_SUSPEND_TRADER,
  // COCKPIT_FULL_ACTIVATION, COCKPIT_EMERGENCY_CLOSE, COCKPIT_FREEZE_INVESTOR,
  // COCKPIT_UNFREEZE_INVESTOR, COCKPIT_RESTORE_TRADER, COCKPIT_MANUAL_NOTE,
  // COCKPIT_REFRESH.
  actionType: text("action_type").notNull(),
  // What the action targeted: trader | investor | bridge | global | note.
  targetType: text("target_type").notNull().default("global"),
  targetUserId: integer("target_user_id"),
  beforeState: jsonb("before_state").notNull().default({}),
  afterState: jsonb("after_state").notNull().default({}),
  // The id of the canonical audit row written by the delegated handler, when
  // resolvable. Lets the cockpit timeline cross-reference the real audit.
  delegatedAuditRef: text("delegated_audit_ref"),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  adminIdx: index("admin_cockpit_audit_admin_idx").on(t.adminUserId),
  targetIdx: index("admin_cockpit_audit_target_idx").on(t.targetUserId),
  actionIdx: index("admin_cockpit_audit_action_idx").on(t.actionType),
  createdIdx: index("admin_cockpit_audit_created_idx").on(t.createdAt),
}));
export type AdminCockpitAuditLogRow = typeof adminCockpitAuditLogTable.$inferSelect;

// ─── 2. Cockpit risk/operations alerts ──────────────────────────────────────
// Derived anomalies surfaced in the cockpit right-rail. Created by the cockpit
// read aggregation (and operator actions). NEVER an execution gate — advisory.
export const adminCockpitAlertsTable = pgTable("admin_cockpit_alerts", {
  id: serial("id").primaryKey(),
  // INFO | WARNING | CRITICAL
  alertLevel: text("alert_level").notNull().default("INFO"),
  // BRIDGE_OFFLINE | EXPOSURE_BREACH | DAILY_LOSS_BREACH | KILL_SWITCH |
  // UNATTRIBUTED_TRADE | APPROVAL_PENDING | PATTERN_SYNC | RISK | CAPITAL
  alertType: text("alert_type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  symbol: text("symbol"),
  targetUserId: integer("target_user_id"),
  relatedTradeId: integer("related_trade_id"),
  relatedCommandId: integer("related_command_id"),
  // ACTIVE | ACKNOWLEDGED | RESOLVED
  status: text("status").notNull().default("ACTIVE"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: integer("acknowledged_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: integer("resolved_by"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("admin_cockpit_alerts_status_idx").on(t.status),
  typeIdx: index("admin_cockpit_alerts_type_idx").on(t.alertType),
  targetIdx: index("admin_cockpit_alerts_target_idx").on(t.targetUserId),
  createdIdx: index("admin_cockpit_alerts_created_idx").on(t.createdAt),
}));
export type AdminCockpitAlertRow = typeof adminCockpitAlertsTable.$inferSelect;

// ─── 3. Cockpit operator notes ──────────────────────────────────────────────
// Free-text operator annotations on a target (trader/investor/global). Never
// user-facing; advisory only.
export const adminCockpitNotesTable = pgTable("admin_cockpit_notes", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id"),
  // trader | investor | global
  targetType: text("target_type").notNull().default("global"),
  targetUserId: integer("target_user_id"),
  note: text("note").notNull(),
  isPinned: boolean("is_pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  targetIdx: index("admin_cockpit_notes_target_idx").on(t.targetUserId),
  typeIdx: index("admin_cockpit_notes_type_idx").on(t.targetType),
  createdIdx: index("admin_cockpit_notes_created_idx").on(t.createdAt),
}));
export type AdminCockpitNoteRow = typeof adminCockpitNotesTable.$inferSelect;
