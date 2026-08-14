// Build MM — Admin Control Service.
//
// SAFETY: Admin actions are routed through a strict allowlist. Forbidden
// actions are rejected as CRITICAL audit events. NO admin action can place
// trades, enable live trading, flip the trading-permission flag, change
// BROKER_MODE away from READ_ONLY, change MARKET_DATA_MODE away from
// read_only, turn paper_only false, expose secrets, or disable critical
// safety alerts.

import { db, adminActionLogsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auditEvent } from "./audit.js";
import { getConfig, patchConfig } from "./config.js";
import { runHealthCheck, runSubsystemCheck, exportHealthReport } from "./health.js";
import { exportAudit } from "./audit.js";
import { checkAdminActionSecurity } from "../security/service.js";

// ── Allowlist + denylist ───────────────────────────────────────────────────
export const ALLOWED_ADMIN_ACTIONS = [
  "RUN_FULL_HEALTH_CHECK",
  "RUN_SUBSYSTEM_CHECK",
  "STOP_PAPER_AUTOPILOT",
  "PAUSE_PAPER_AUTOPILOT",
  "EMERGENCY_WATCH_ONLY",
  "ACKNOWLEDGE_CRITICAL_NOTIFICATION",
  "REBUILD_PERFORMANCE",
  "REGENERATE_TRADER_COACH_REPORT",
  "GENERATE_NOTIFICATION_DIGEST",
  "RUN_REPLAY_DEMO",
  "RUN_DATA_IMPORT_DEMO",
  "CLEAR_DEMO_DATA",
  "EXPORT_AUDIT_REPORT",
  "EXPORT_HEALTH_REPORT",
  "UPDATE_NOTIFICATION_PREFERENCES",
  "UPDATE_PAPER_AUTOPILOT_SETTINGS",
] as const;

export const FORBIDDEN_ADMIN_ACTIONS = [
  "ENABLE_LIVE_TRADING",
  "SET_CAN_PLACE_TRADES_TRUE",
  "CALL_BROKER_PLACE_ORDER",
  "CALL_MT5_LIVE_EXECUTION",
  "CLOSE_REAL_POSITION",
  "MODIFY_REAL_ORDER",
  "EXPOSE_SECRETS",
  "DISABLE_CRITICAL_SAFETY_ALERTS",
  "CHANGE_BROKER_MODE",
  "CHANGE_MARKET_DATA_MODE",
  "DISABLE_PAPER_ONLY",
] as const;

export type AllowedAction = typeof ALLOWED_ADMIN_ACTIONS[number];
export type ForbiddenAction = typeof FORBIDDEN_ADMIN_ACTIONS[number];

const PROXY_BASE = "http://localhost:80";
async function proxyPost(path: string, body: unknown = {}): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(`${PROXY_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let parsed: unknown = null; try { parsed = await r.json(); } catch { /* ignore */ }
    return { status: r.status, body: parsed };
  } catch (err) { return { status: 0, body: { error: String(err).slice(0, 120) } }; }
}

export interface AdminActionRequest {
  action: string;
  reason?: string;
  requestedBy?: string;
  payload?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AdminActionResult {
  status: "ACCEPTED" | "REJECTED" | "FAILED" | "COMPLETED";
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  adminActionId: string;
  auditId: string;
  liveTradingStatus: "DISABLED";
  result?: Record<string, unknown>;
  reason?: string;
}

function isForbidden(action: string): boolean {
  const a = action.toUpperCase();
  if ((FORBIDDEN_ADMIN_ACTIONS as readonly string[]).includes(a)) return true;
  if (/LIVE[_-]?TRADING|CAN[_-]?PLACE[_-]?TRADES|EXECUTE[_-]?TRADE|MT5[_-]?LIVE|PLACE[_-]?ORDER|REAL[_-]?ORDER|CLOSE[_-]?REAL/i.test(action)) return true;
  return false;
}

export async function performAdminAction(req: AdminActionRequest): Promise<AdminActionResult> {
  const adminActionId = `act_${randomUUID()}`;
  const action = String(req.action ?? "").toUpperCase();
  const requestedBy = req.requestedBy ?? "ADMIN";

  // 0) Build NN security gate — runs before everything else.
  const security = await checkAdminActionSecurity(action, requestedBy);
  if (!security.allowed) {
    const audit = await auditEvent({
      eventType: "ADMIN_ACTION_REJECTED", severity: security.severity, sourceBuild: "MM",
      sourceService: "admin-control", actor: "ADMIN", action,
      metadata: { reason: security.reason, securityEventId: security.securityEventId, permissionKey: security.permissionKey, payload: req.payload },
      ipAddress: req.ipAddress, userAgent: req.userAgent,
    });
    await db.insert(adminActionLogsTable).values({
      adminActionId, action, status: "REJECTED", severity: security.severity, requestedBy,
      reason: security.reason, auditId: audit.auditId,
      result: { rejected: true, securityEventId: security.securityEventId, liveTradingStatus: "DISABLED" },
    });
    return { status: "REJECTED", severity: security.severity, adminActionId, auditId: audit.auditId, liveTradingStatus: "DISABLED", reason: security.reason };
  }

  // 1) Forbidden action → REJECTED + CRITICAL audit
  if (isForbidden(action)) {
    const audit = await auditEvent({
      eventType: "ADMIN_ACTION_REJECTED", severity: "CRITICAL", sourceBuild: "MM",
      sourceService: "admin-control", actor: "ADMIN", action,
      metadata: { reason: "FORBIDDEN — Build MM cannot enable live trading or place trades", payload: req.payload },
      ipAddress: req.ipAddress, userAgent: req.userAgent,
    });
    await db.insert(adminActionLogsTable).values({
      adminActionId, action, status: "REJECTED", severity: "CRITICAL", requestedBy,
      reason: req.reason ?? "FORBIDDEN", auditId: audit.auditId,
      result: { rejected: true, hardLock: true, liveTradingStatus: "DISABLED" },
    });
    return { status: "REJECTED", severity: "CRITICAL", adminActionId, auditId: audit.auditId, liveTradingStatus: "DISABLED",
             reason: "FORBIDDEN — live trading is hard-locked. Build MM cannot place trades or enable live trading." };
  }

  // 2) Unknown action
  if (!(ALLOWED_ADMIN_ACTIONS as readonly string[]).includes(action)) {
    const audit = await auditEvent({ eventType: "ADMIN_ACTION_REJECTED", severity: "WARNING", sourceBuild: "MM", sourceService: "admin-control", actor: "ADMIN", action, metadata: { reason: "UNKNOWN_ACTION" } });
    await db.insert(adminActionLogsTable).values({ adminActionId, action, status: "REJECTED", severity: "WARNING", requestedBy, reason: "UNKNOWN_ACTION", auditId: audit.auditId, result: { rejected: true } });
    return { status: "REJECTED", severity: "WARNING", adminActionId, auditId: audit.auditId, liveTradingStatus: "DISABLED", reason: "Unknown admin action" };
  }

  // 3) Allowed action → execute safely
  const beforeCfg = await getConfig();
  let result: Record<string, unknown> = {};
  let status: AdminActionResult["status"] = "COMPLETED";
  let severity: AdminActionResult["severity"] = "INFO";
  try {
    switch (action as AllowedAction) {
      case "RUN_FULL_HEALTH_CHECK": {
        const r = await runHealthCheck();
        result = { healthCheckId: r.health_check_id, overallStatus: r.overallStatus, warnings: r.warnings.length, errors: r.errors.length };
        break;
      }
      case "RUN_SUBSYSTEM_CHECK": {
        const b = String(req.payload?.["build"] ?? "AA").toUpperCase() as Parameters<typeof runSubsystemCheck>[0];
        result = { build: b, ...(await runSubsystemCheck(b)) };
        break;
      }
      case "STOP_PAPER_AUTOPILOT": {
        const r = await proxyPost("/api/paper-autopilot/stop", { reason: req.reason ?? "MM admin stop" });
        await patchConfig({ paperAutopilotEnabled: false });
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "PAUSE_PAPER_AUTOPILOT": {
        const r = await proxyPost("/api/paper-autopilot/pause", { reason: req.reason ?? "MM admin pause" });
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "EMERGENCY_WATCH_ONLY": {
        const r = await proxyPost("/api/risk-governor/emergency-pause", { reason: req.reason ?? "MM emergency WATCH_ONLY" });
        await patchConfig({ paperAutopilotEnabled: false, currentSafetyLock: "EMERGENCY_WATCH_ONLY" });
        severity = "HIGH";
        result = { proxyStatus: r.status, response: r.body, mode: "WATCH_ONLY", liveTradingStatus: "DISABLED" };
        break;
      }
      case "ACKNOWLEDGE_CRITICAL_NOTIFICATION": {
        const id = String(req.payload?.["notificationId"] ?? "");
        if (!id) { status = "FAILED"; severity = "WARNING"; result = { error: "notificationId required" }; break; }
        const r = await proxyPost(`/api/notifications/${encodeURIComponent(id)}/acknowledge`);
        result = { notificationId: id, proxyStatus: r.status, response: r.body };
        break;
      }
      case "REBUILD_PERFORMANCE": {
        const r = await proxyPost("/api/performance/ai-command-center/rebuild", req.payload ?? {});
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "REGENERATE_TRADER_COACH_REPORT": {
        const r = await proxyPost("/api/trader-coach/generate", req.payload ?? {});
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "GENERATE_NOTIFICATION_DIGEST": {
        const r = await proxyPost("/api/notifications/digest/generate", { rangeHours: Number(req.payload?.["rangeHours"] ?? 24) });
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "RUN_REPLAY_DEMO": {
        const r = await proxyPost("/api/replay/demo", req.payload ?? {});
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "RUN_DATA_IMPORT_DEMO": {
        const r = await proxyPost("/api/data-import/demo", req.payload ?? {});
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
      case "CLEAR_DEMO_DATA": {
        // No-op safe scaffold: only acknowledges; real clear must be marked DEMO and is per-build.
        result = { cleared: false, note: "CLEAR_DEMO_DATA accepted but no-op in MM (each build owns its DEMO clear)" };
        break;
      }
      case "EXPORT_AUDIT_REPORT": {
        const exp = await exportAudit(Number(req.payload?.["limit"] ?? 200));
        result = { exportId: exp.exportId, count: exp.count };
        break;
      }
      case "EXPORT_HEALTH_REPORT": {
        const exp = await exportHealthReport();
        result = { exportId: exp.exportId, overallStatus: exp.report.overallStatus };
        break;
      }
      case "UPDATE_NOTIFICATION_PREFERENCES": {
        const r = await proxyPost("/api/notifications/preferences", req.payload ?? {});
        result = { proxyStatus: r.status, response: r.body, note: "critical_alerts_always_on and safety_alerts_enabled remain hard-locked" };
        break;
      }
      case "UPDATE_PAPER_AUTOPILOT_SETTINGS": {
        // Build NN hard rule: any forbidden key in payload is treated as a forbidden attempt
        // (HTTP 403 + CRITICAL audit + security event). No silent stripping.
        const payload = (req.payload ?? {}) as Record<string, unknown>;
        const FORBIDDEN_KEY_RE = /live[_-]?trading|canPlaceTrades|broker[_-]?mode|paper[_-]?only|mt5[_-]?live|broker[_-]?execute/i;
        const offendingKeys = Object.keys(payload).filter((k) => FORBIDDEN_KEY_RE.test(k));
        if (offendingKeys.length > 0) {
          const { recordSecurityEvent: nnRecord } = await import("../security/events.js");
          const evt = await nnRecord({
            eventType: "FORBIDDEN_ACTION_ATTEMPTED", severity: "CRITICAL", status: "DENIED",
            actorRole: "ADMIN", permissionKey: "forbidden:live_trade_enable",
            route: "/api/admin-control/action", method: "POST",
            message: `Payload-level forbidden keys in UPDATE_PAPER_AUTOPILOT_SETTINGS: ${offendingKeys.join(",")}`,
            metadata: { offendingKeys, action: "UPDATE_PAPER_AUTOPILOT_SETTINGS" },
          });
          status = "REJECTED"; severity = "CRITICAL";
          result = { rejected: true, reason: `FORBIDDEN payload keys: ${offendingKeys.join(", ")}`, offendingKeys, securityEventId: evt.securityEventId, liveTradingStatus: "DISABLED" };
          break;
        }
        const r = await proxyPost("/api/paper-autopilot/config", payload);
        result = { proxyStatus: r.status, response: r.body };
        break;
      }
    }
  } catch (err) {
    status = "FAILED"; severity = "HIGH";
    result = { error: String(err).slice(0, 200) };
  }

  const audit = await auditEvent({
    eventType: "ADMIN_ACTION", severity, sourceBuild: "MM", sourceService: "admin-control", actor: "ADMIN",
    action, beforeSnapshot: beforeCfg, afterSnapshot: await getConfig(),
    metadata: { result, reason: req.reason ?? null }, ipAddress: req.ipAddress, userAgent: req.userAgent,
  });
  await db.insert(adminActionLogsTable).values({ adminActionId, action, status, severity, requestedBy, reason: req.reason ?? null, auditId: audit.auditId, result });

  return { status, severity, adminActionId, auditId: audit.auditId, liveTradingStatus: "DISABLED", result };
}

export async function listAdminActions(limit = 50) {
  return db.select().from(adminActionLogsTable).orderBy(desc(adminActionLogsTable.createdAt)).limit(Math.min(Math.max(limit, 1), 500));
}

export async function seedAdminDemo(): Promise<{ accepted: AdminActionResult; rejected: AdminActionResult; export: AdminActionResult; }> {
  const accepted = await performAdminAction({ action: "RUN_FULL_HEALTH_CHECK", reason: "demo" });
  const rejected = await performAdminAction({ action: "ENABLE_LIVE_TRADING", reason: "demo (forbidden)", requestedBy: "ADMIN" });
  const exp      = await performAdminAction({ action: "EXPORT_HEALTH_REPORT", reason: "demo" });
  return { accepted, rejected, export: exp };
}
