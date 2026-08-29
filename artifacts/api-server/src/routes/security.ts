// Build NN — Security routes.

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, securityRolesTable, securityPermissionsTable, securityRolePermissionsTable, securityUserRolesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildSecurityStatus, createDataProtectionExport, listDataProtectionExports } from "../lib/security/service.js";
import { seedSecurity, ROLE_KEYS, PERMISSIONS } from "../lib/security/seed.js";
import { checkPermission } from "../lib/security/permissions.js";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { getSettings, patchSettings } from "../lib/security/settings.js";
import { listEvents, listAccessLogs, recordSecurityEvent, recordAccessLog, repeatedDeniedCount } from "../lib/security/events.js";
import { redactionSelfTest, scrub } from "../lib/security/redact.js";

const router: IRouter = Router();

const ENVELOPE = {
  system: "security",
  liveTradingStatus: "DISABLED" as const,
  mode: "PAPER_ONLY" as const,
  canPlaceLiveTrade: false,
  disclaimer: "Build NN — Security, Roles, Permissions, and Data Protection. Never places trades, never enables live trading, never exposes secrets, never modifies canPlaceTrades.",
};

function envelope<T extends object>(payload: T) { return { ...ENVELOPE, ...payload }; }

async function denyResponse(req: Request, res: Response, role: string, permissionKey: string, reason: string, forbidden = false) {
  const sev: "WARNING" | "CRITICAL" = forbidden ? "CRITICAL" : "WARNING";
  const evt = await recordSecurityEvent({
    eventType: forbidden ? "FORBIDDEN_ACTION_ATTEMPTED" : "PERMISSION_DENIED",
    severity: sev, status: "DENIED", actorRole: role, permissionKey,
    route: req.originalUrl, method: req.method, message: reason,
  });
  await recordAccessLog({
    requestId: req.id ? String(req.id) : null, role, route: req.originalUrl, method: req.method,
    statusCode: 403, permissionRequired: permissionKey, allowed: false, reason,
    metadata: { securityEventId: evt.securityEventId, forbidden },
  });
  const repeats = await repeatedDeniedCount(role, req.originalUrl, 50);
  if (repeats >= 3) {
    await recordSecurityEvent({
      eventType: "REPEATED_DENIED_REQUESTS", severity: "WARNING", status: "TRIGGERED",
      actorRole: role, route: req.originalUrl, method: req.method,
      message: `Role ${role} denied ${repeats}× on ${req.originalUrl}`, metadata: { repeats },
    });
  }
  res.status(403).json(envelope({ result: { status: "REJECTED", severity: sev, role, permissionKey, reason, securityEventId: evt.securityEventId, forbidden } }));
}

// ── Read gate ────────────────────────────────────────────────────────────────
// Every GET below returns admin security posture: the full role×permission
// matrix, user-role assignments, the security event log, access logs, settings
// and the data-protection export list. Before this gate the POSTs were guarded
// but the GETs were not, so any signed-in trader could read all of it by
// hitting the URL — confidentiality rested entirely on the client-side
// routeAccess hiding of the pages. `security:read` is held by OWNER and ADMIN
// only (lib/security/seed.ts ROLE_PERMISSIONS), so TRADER/ANALYST/VIEWER now
// get the same audited 403 the POSTs already produced.
function requireSecurityRead(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  const refuse = async (r: string, key: string, reason: string, forbidden = false) => {
    try {
      await denyResponse(req, res, r, key, reason, forbidden);
    } catch {
      // The audit write itself failed. A failure to RECORD the refusal must
      // never become permission — answer 403 anyway, plainly.
      if (!res.headersSent) {
        res.status(403).json(envelope({ result: { status: "REJECTED", severity: "WARNING", role: r, permissionKey: key, reason, auditRecorded: false } }));
      }
    }
  };
  void checkPermission(role, "security:read")
    .then(async (decision) => {
      if (decision.allowed) { next(); return; }
      await refuse(decision.role, decision.permissionKey, decision.reason, decision.forbidden);
    })
    .catch(async () => {
      // Fail CLOSED: an unreadable permission table is not permission.
      await refuse(role, "security:read", "security permission check unavailable — failing closed");
    });
}

router.get("/security/status", requireSecurityRead, async (_req, res) => {
  await seedSecurity();
  const status = await buildSecurityStatus();
  const settings = await getSettings();
  res.json(envelope({ status, settings }));
});

router.post("/security/check", requireSecurityRead, async (_req, res) => {
  await seedSecurity();
  const status = await buildSecurityStatus();
  res.json(envelope({ status }));
});

router.get("/security/roles", requireSecurityRead, async (_req, res) => {
  await seedSecurity();
  const roles = await db.select().from(securityRolesTable);
  res.json(envelope({ count: roles.length, roles }));
});

router.post("/security/roles", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "security:manage_roles");
  if (!decision.allowed) { await denyResponse(req, res, decision.role, decision.permissionKey, decision.reason, decision.forbidden); return; }
  // Hard rule: built-in roles cannot be modified; this endpoint only seeds + reports.
  const out = await seedSecurity();
  res.json(envelope({ seeded: out, note: "Built-in roles are immutable; only seeding is performed." }));
});

router.get("/security/permissions", requireSecurityRead, async (_req, res) => {
  await seedSecurity();
  const perms = await db.select().from(securityPermissionsTable);
  res.json(envelope({ count: perms.length, permissions: perms }));
});

router.get("/security/role-permissions", requireSecurityRead, async (req, res) => {
  await seedSecurity();
  const roles = await db.select().from(securityRolesTable);
  const perms = await db.select().from(securityPermissionsTable);
  const mappings = await db.select().from(securityRolePermissionsTable);
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const r of roles) {
    matrix[r.roleKey] = {};
    for (const p of perms) {
      const m = mappings.find((x) => x.roleId === r.id && x.permissionId === p.id);
      matrix[r.roleKey][p.permissionKey] = m ? m.allowed : false;
    }
  }
  // Forbidden permissions are always false for every role.
  for (const r of Object.keys(matrix)) {
    for (const p of perms.filter((x) => x.isForbidden)) matrix[r][p.permissionKey] = false;
  }
  void req;
  res.json(envelope({ matrix, roles: roles.length, permissions: perms.length }));
});

router.post("/security/role-permissions", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "security:manage_roles");
  if (!decision.allowed) { await denyResponse(req, res, decision.role, decision.permissionKey, decision.reason, decision.forbidden); return; }
  res.json(envelope({ note: "Built-in role-permission mappings are immutable; use seed.ts to evolve.", matrixPreview: PERMISSIONS.length }));
});

router.get("/security/user-roles", requireSecurityRead, async (_req, res) => {
  const rows = await db.select().from(securityUserRolesTable);
  res.json(envelope({ count: rows.length, userRoles: rows }));
});

router.post("/security/user-roles", async (req, res) => {
  const callerRole = readRoleFromRequest(req);
  const decision = await checkPermission(callerRole, "security:manage_roles");
  if (!decision.allowed) { await denyResponse(req, res, decision.role, decision.permissionKey, decision.reason, decision.forbidden); return; }
  const userId = Number(req.body?.userId);
  const roleKey = String(req.body?.roleKey ?? "").toUpperCase();
  if (!userId || !(ROLE_KEYS as readonly string[]).includes(roleKey)) {
    res.status(400).json(envelope({ error: "userId (number) and valid roleKey required" })); return;
  }
  const [r] = await db.select().from(securityRolesTable).where(eq(securityRolesTable.roleKey, roleKey)).limit(1);
  if (!r) { res.status(404).json(envelope({ error: "role not found" })); return; }
  const [created] = await db.insert(securityUserRolesTable).values({ userId, roleId: r.id, assignedBy: callerRole }).returning();
  await recordSecurityEvent({
    eventType: "ROLE_CHANGED", severity: "HIGH", status: "TRIGGERED", actorRole: callerRole,
    message: `Role ${roleKey} assigned to user ${userId}`, metadata: { userId, roleKey },
  });
  res.json(envelope({ assigned: created }));
});

router.post("/security/test-permission", requireSecurityRead, async (req, res) => {
  // Phase 28-SEC: body-provided role for explicit test; otherwise trusted server-derived role. Header is no longer trusted.
  const role = String(req.body?.role ?? readRoleFromRequest(req));
  const permissionKey = String(req.body?.permissionKey ?? "");
  if (!permissionKey) { res.status(400).json(envelope({ error: "permissionKey required" })); return; }
  const decision = await checkPermission(role, permissionKey);
  await recordSecurityEvent({
    eventType: decision.allowed ? "PERMISSION_GRANTED" : (decision.forbidden ? "FORBIDDEN_ACTION_ATTEMPTED" : "PERMISSION_DENIED"),
    severity: decision.forbidden ? "CRITICAL" : (decision.allowed ? "INFO" : "WARNING"),
    status: decision.allowed ? "ALLOWED" : "DENIED",
    actorRole: decision.role, permissionKey, message: decision.reason,
  });
  res.json(envelope({ decision }));
});

router.post("/security/forbidden-action-test", requireSecurityRead, async (req, res) => {
  // Phase 28-SEC: body-provided role for explicit forbidden-action test; otherwise trusted server-derived role. Header is no longer trusted.
  const role = String(req.body?.role ?? readRoleFromRequest(req));
  const action = String(req.body?.action ?? "ENABLE_LIVE_TRADING");
  const decision = await checkPermission(role, "forbidden:live_trade_enable");
  const evt = await recordSecurityEvent({
    eventType: "FORBIDDEN_ACTION_ATTEMPTED", severity: "CRITICAL", status: "DENIED",
    actorRole: role, permissionKey: "forbidden:live_trade_enable",
    message: `Forbidden action attempted: ${action}`, metadata: { action },
  });
  res.status(403).json(envelope({ result: {
    status: "REJECTED", severity: "CRITICAL", reason: decision.reason,
    liveTradingStatus: "DISABLED", securityEventId: evt.securityEventId, action,
  } }));
});

router.get("/security/events", requireSecurityRead, async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const eventType = req.query.eventType ? String(req.query.eventType) : undefined;
  const events = await listEvents(limit, eventType);
  res.json(envelope({ count: events.length, events }));
});

router.get("/security/access-logs", requireSecurityRead, async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const logs = await listAccessLogs(limit);
  res.json(envelope({ count: logs.length, accessLogs: logs }));
});

router.get("/security/settings", requireSecurityRead, async (_req, res) => {
  const settings = await getSettings();
  res.json(envelope({ settings }));
});

router.post("/security/settings", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "security:manage_settings");
  if (!decision.allowed) { await denyResponse(req, res, decision.role, decision.permissionKey, decision.reason, decision.forbidden); return; }
  const result = await patchSettings(req.body ?? {});
  if (result.attemptedHardLockChange) {
    const evt = await recordSecurityEvent({
      eventType: "FORBIDDEN_ACTION_ATTEMPTED", severity: "CRITICAL", status: "DENIED",
      actorRole: role, permissionKey: "forbidden:live_trade_enable",
      route: req.originalUrl, method: req.method,
      message: `Attempt to flip hard-locked security settings: ${result.rejected.join(",")}`,
      metadata: { attempted: result.rejected },
    });
    await recordAccessLog({
      requestId: req.id ? String(req.id) : null, role, route: req.originalUrl, method: req.method,
      statusCode: 403, permissionRequired: "security:manage_settings", allowed: false,
      reason: "Hard-locked settings cannot be changed", metadata: { securityEventId: evt.securityEventId, attempted: result.rejected },
    });
    res.status(403).json(envelope({ result: { status: "REJECTED", severity: "CRITICAL", reason: `Hard-locked settings cannot be changed: ${result.rejected.join(", ")}`, securityEventId: evt.securityEventId, attempted: result.rejected, liveTradingStatus: "DISABLED" } }));
    return;
  }
  await recordSecurityEvent({
    eventType: "SECURITY_SETTING_CHANGED", severity: "HIGH", status: "TRIGGERED", actorRole: role,
    message: `Security settings updated by ${role}`, metadata: { rejected: result.rejected, applied: Object.keys(req.body ?? {}) },
  });
  res.json(envelope({ settings: result.settings, rejectedKeys: result.rejected }));
});

router.post("/security/demo", requireSecurityRead, async (_req, res) => {
  await seedSecurity();
  const status = await buildSecurityStatus();
  const allowed = await checkPermission("TRADER", "paper_trade:create");
  const denied  = await checkPermission("VIEWER", "paper_trade:create");
  const forbidden = await checkPermission("OWNER", "forbidden:live_trade_enable");
  await recordSecurityEvent({
    eventType: "PERMISSION_GRANTED", severity: "INFO", status: "ALLOWED",
    actorRole: "TRADER", permissionKey: "paper_trade:create", message: "demo allowed",
  });
  await recordSecurityEvent({
    eventType: "PERMISSION_DENIED", severity: "WARNING", status: "DENIED",
    actorRole: "VIEWER", permissionKey: "paper_trade:create", message: "demo denied",
  });
  await recordSecurityEvent({
    eventType: "FORBIDDEN_ACTION_ATTEMPTED", severity: "CRITICAL", status: "DENIED",
    actorRole: "OWNER", permissionKey: "forbidden:live_trade_enable", message: "demo forbidden",
  });
  res.json(envelope({ demo: true, status, decisions: { allowed, denied, forbidden } }));
});

router.post("/security/export-data", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "audit:export");
  if (!decision.allowed) { await denyResponse(req, res, decision.role, decision.permissionKey, decision.reason, decision.forbidden); return; }
  const exp = await createDataProtectionExport(req.body ?? {}, role);
  res.json(envelope({ export: exp, note: "All exports are scrub()-ed before persistence" }));
});

router.get("/security/data-protection/exports", requireSecurityRead, async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const items = await listDataProtectionExports(limit);
  res.json(envelope({ count: items.length, exports: items }));
});

router.post("/security/redaction-test", requireSecurityRead, async (req, res) => {
  const sample = (req.body && Object.keys(req.body).length > 0) ? req.body : {
    api_key: "abc123", broker_api_secret: "topsecret",
    note: "token sk_live_ABCDEFGHIJKLMNO and AKIAABCDEFGHIJKLMNOP",
    account_id: "1234567890",
    db: "postgresql://user:pass@host:5432/db",
  };
  const out = scrub(sample);
  const selfTest = redactionSelfTest();
  res.json(envelope({ input_sample: Object.keys(sample as Record<string, unknown>), redacted: out, selfTest }));
});

// Convenience for HH integration.
router.get("/security/integration/hh", requireSecurityRead, async (_req, res) => {
  const status = await buildSecurityStatus();
  const recommend: "PAPER_ALLOWED" | "PAPER_CAUTION" | "WATCH_ONLY" | "LOCKED" =
    status.criticalFindings.length > 0 ? "LOCKED"
    : status.warnings.length > 0 ? "WATCH_ONLY"
    : status.securityFlags.some((f) => f.startsWith("forbidden_attempts_last_hour=")) ? "PAPER_CAUTION"
    : "PAPER_ALLOWED";
  res.json(envelope({ recommend, criticalFindings: status.criticalFindings, warnings: status.warnings, flags: status.securityFlags }));
});

const _req: Request | undefined = undefined; void _req;
const _res: Response | undefined = undefined; void _res;

export default router;
