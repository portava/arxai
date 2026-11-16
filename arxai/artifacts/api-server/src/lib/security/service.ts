// Build NN — Security status orchestrator + integration points for MM/HH/LL.

import { db, securityRolesTable, securityPermissionsTable, securityEventsTable, dataProtectionExportsTable } from "@workspace/db";
import { desc, eq, gte } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { buildExportEnvelopeMeta, canonicalExportPayload } from "@workspace/domain/security";
import { getSettings } from "./settings.js";
import { redactionSelfTest, redactForAudit } from "./redact.js";
import { checkPermission } from "./permissions.js";
import { recordSecurityEvent, recordCriticalSecurityEvent, mirrorCriticalEvent } from "./events.js";
import { consultSecurityHandshake } from "./handshake.js";

export interface SecurityStatusReport {
  security_status_id: string;
  generated_at: string;
  appMode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  authStatus: {
    authConfigured: boolean;
    sessionProtectionEnabled: boolean;
    csrfProtectionEnabled: boolean;
    rateLimitEnabled: boolean;
    roleSystemEnabled: boolean;
  };
  permissionStatus: {
    rolesConfigured: number;
    permissionsConfigured: number;
    forbiddenPermissions: number;
    protectedRoutesCount: number;
    unprotectedSensitiveRoutes: string[];
    adminOnlyRoutes: string[];
    readOnlyRoutes: string[];
  };
  dataProtectionStatus: {
    secretRedactionEnabled: boolean;
    accountMaskingEnabled: boolean;
    brokerSecretsProtected: boolean;
    marketDataSecretsProtected: boolean;
    exportAvailable: boolean;
    demoDataSeparated: boolean;
    redactionSelfTest: ReturnType<typeof redactionSelfTest>;
  };
  securityFlags: string[];
  warnings: string[];
  criticalFindings: string[];
  recommendedActions: string[];
}

const PROTECTED_ROUTES = [
  { path: "/api/admin-control/action", admin: true, perm: "admin:health_check" },
  { path: "/api/admin-control/emergency-watch-only", admin: true, perm: "admin:watch_only" },
  { path: "/api/admin-control/stop-autopilot", admin: true, perm: "admin:health_check" },
  { path: "/api/admin-control/rebuild-performance", admin: true, perm: "admin:rebuild" },
  { path: "/api/admin-control/generate-coach-report", admin: true, perm: "coach:generate" },
  { path: "/api/admin-control/generate-notification-digest", admin: true, perm: "notifications:manage" },
  { path: "/api/admin-control/export-health-report", admin: true, perm: "audit:export" },
  { path: "/api/audit/export", admin: true, perm: "audit:export" },
  { path: "/api/security/roles", admin: true, perm: "security:manage_roles" },
  { path: "/api/security/role-permissions", admin: true, perm: "security:manage_roles" },
  { path: "/api/security/user-roles", admin: true, perm: "security:manage_roles" },
  { path: "/api/security/settings", admin: true, perm: "security:manage_settings" },
  { path: "/api/security/forbidden-action-test", admin: false, perm: "security:read" },
];

export async function buildSecurityStatus(): Promise<SecurityStatusReport> {
  const settings = await getSettings();
  const roles = await db.select().from(securityRolesTable);
  const perms = await db.select().from(securityPermissionsTable);
  const forbidden = perms.filter((p) => p.isForbidden);

  const flags: string[] = [];
  const warnings: string[] = [];
  const critical: string[] = [];
  const recommended: string[] = [];

  if (!settings.secretRedactionEnabled) critical.push("Secret redaction is disabled");
  if (!settings.criticalAlertsAlwaysOn) critical.push("Critical alerts always-on is disabled");
  if (!settings.paperOnlyEnforced) critical.push("Paper-only enforcement is disabled");
  if (!settings.liveTradingPermanentlyDisabled) critical.push("Live trading permanent disable flag is OFF");
  if (!settings.auditLoggingEnabled) critical.push("Audit logging is disabled");
  if (!settings.roleSystemEnabled) warnings.push("Role system is disabled");
  if (!settings.authRequired) warnings.push("Auth is not required (single-tenant mode)");

  const selfTest = redactionSelfTest();
  const allRedactionsOk = Object.values(selfTest).every(Boolean);
  if (!allRedactionsOk) critical.push("Redaction self-test failed");

  // Recent forbidden attempts within last hour
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recentForbidden = await db.select().from(securityEventsTable)
    .where(gte(securityEventsTable.createdAt, since)).limit(500);
  const forbAttempts = recentForbidden.filter((e) => e.eventType === "FORBIDDEN_ACTION_ATTEMPTED").length;
  if (forbAttempts > 0) {
    flags.push(`forbidden_attempts_last_hour=${forbAttempts}`);
    recommended.push(`Investigate ${forbAttempts} forbidden action attempt(s) in the last hour`);
  }

  flags.push("LIVE_TRADING_PERMANENTLY_DISABLED", "PAPER_ONLY", "BROKER_READ_ONLY");

  return {
    security_status_id: `secstatus_${randomUUID()}`,
    generated_at: new Date().toISOString(),
    appMode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    authStatus: {
      authConfigured: settings.authRequired,
      sessionProtectionEnabled: settings.authRequired,
      csrfProtectionEnabled: false,
      rateLimitEnabled: settings.rateLimitEnabled,
      roleSystemEnabled: settings.roleSystemEnabled,
    },
    permissionStatus: {
      rolesConfigured: roles.length,
      permissionsConfigured: perms.length,
      forbiddenPermissions: forbidden.length,
      protectedRoutesCount: PROTECTED_ROUTES.length,
      unprotectedSensitiveRoutes: [],
      adminOnlyRoutes: PROTECTED_ROUTES.filter((r) => r.admin).map((r) => r.path),
      readOnlyRoutes: PROTECTED_ROUTES.filter((r) => !r.admin).map((r) => r.path),
    },
    dataProtectionStatus: {
      secretRedactionEnabled: settings.secretRedactionEnabled,
      accountMaskingEnabled: true,
      brokerSecretsProtected: true,
      marketDataSecretsProtected: true,
      exportAvailable: true,
      demoDataSeparated: true,
      redactionSelfTest: selfTest,
    },
    securityFlags: flags,
    warnings,
    criticalFindings: critical,
    recommendedActions: recommended,
  };
}

// Used by MM admin.ts before executing each admin action.
export async function checkAdminActionSecurity(action: string, role: string | undefined): Promise<{ allowed: boolean; severity: "INFO"|"WARNING"|"HIGH"|"CRITICAL"; reason: string; securityEventId: string; permissionKey: string; }> {
  const a = String(action ?? "").toUpperCase();
  const map: Record<string, string> = {
    RUN_FULL_HEALTH_CHECK: "admin:health_check",
    RUN_SUBSYSTEM_CHECK: "admin:health_check",
    STOP_PAPER_AUTOPILOT: "paper_autopilot:stop",
    PAUSE_PAPER_AUTOPILOT: "paper_autopilot:stop",
    EMERGENCY_WATCH_ONLY: "admin:watch_only",
    ACKNOWLEDGE_CRITICAL_NOTIFICATION: "notifications:manage",
    REBUILD_PERFORMANCE: "admin:rebuild",
    REGENERATE_TRADER_COACH_REPORT: "coach:generate",
    GENERATE_NOTIFICATION_DIGEST: "notifications:manage",
    RUN_REPLAY_DEMO: "replay:run",
    RUN_DATA_IMPORT_DEMO: "data_import:create",
    CLEAR_DEMO_DATA: "admin:rebuild",
    EXPORT_AUDIT_REPORT: "audit:export",
    EXPORT_HEALTH_REPORT: "audit:export",
    UPDATE_NOTIFICATION_PREFERENCES: "notifications:manage",
    UPDATE_PAPER_AUTOPILOT_SETTINGS: "paper_autopilot:start",
  };

  // Forbidden classes — always reject regardless of role.
  if (/(LIVE[_-]?TRADING|CAN[_-]?PLACE[_-]?TRADES|EXECUTE[_-]?TRADE|MT5[_-]?LIVE|PLACE[_-]?ORDER|REAL[_-]?ORDER|CLOSE[_-]?REAL|DISABLE_(?:CRITICAL_)?(?:SAFETY_|AUDIT)|EXPOSE_SECRETS|CHANGE_(?:BROKER|MARKET_DATA)_MODE|DISABLE_PAPER_ONLY)/i.test(a)) {
    const evt = await recordSecurityEvent({
      eventType: "FORBIDDEN_ACTION_ATTEMPTED", severity: "CRITICAL", status: "DENIED",
      actorRole: role ?? null, permissionKey: "forbidden:live_trade_enable",
      message: `MM admin action ${a} blocked by NN`, metadata: { action: a },
    });
    return { allowed: false, severity: "CRITICAL", reason: `FORBIDDEN — ${a} is hard-locked by Build NN`, securityEventId: evt.securityEventId, permissionKey: "forbidden:live_trade_enable" };
  }

  const permissionKey = map[a] ?? "admin:health_check";
  const decision = await checkPermission(role ?? "OWNER", permissionKey);
  if (!decision.allowed) {
    const evt = await recordSecurityEvent({
      eventType: "PERMISSION_DENIED", severity: "WARNING", status: "DENIED",
      actorRole: role ?? null, permissionKey, message: decision.reason, metadata: { action: a },
    });
    return { allowed: false, severity: "WARNING", reason: decision.reason, securityEventId: evt.securityEventId, permissionKey };
  }

  // Security handshake (Phase 2) for EXPORT sensitive actions. The permission
  // check above already passed; the handshake adds the security-posture gate
  // (redaction proven, audit available, no lockdown, admin surface). It can only
  // ADD a block — a passing handshake never relaxes the decision above.
  if (a === "EXPORT_AUDIT_REPORT" || a === "EXPORT_HEALTH_REPORT") {
    // Do NOT hardcode role/permission signals: let the consult derive them
    // action-aware from `role` (admin-only ⇒ require privileged, fail-closed).
    // The seeded permission check above is a separate, additive gate.
    const { verdict } = await consultSecurityHandshake("EXPORT_REPORT", {
      userId: null,
      role,
      authenticated: true,
    });
    if (!verdict.pass) {
      // Critical, tamper-evident: a failed security handshake on a sensitive
      // export is hash-chained so it cannot be retroactively erased.
      const evt = await recordCriticalSecurityEvent({
        eventType: "SECURITY_HANDSHAKE_FAILED", severity: "HIGH", status: "DENIED",
        actorRole: role ?? null, actorType: role ?? null, permissionKey,
        affectedObject: `admin_action:${a}`,
        message: verdict.adminMessage, metadata: { action: a },
      });
      return { allowed: false, severity: "HIGH", reason: verdict.userMessage, securityEventId: evt.securityEventId, permissionKey };
    }
  }

  const evt = await recordSecurityEvent({
    eventType: "PERMISSION_GRANTED", severity: "INFO", status: "ALLOWED",
    actorRole: role ?? null, permissionKey, message: `${a} authorized`, metadata: { action: a },
  });
  return { allowed: true, severity: "INFO", reason: "ALLOWED", securityEventId: evt.securityEventId, permissionKey };
}

export interface CreateExportOptions {
  requestedByRole?: string | null;
  /** True only for an admin-authorized export (may include internal formulas). */
  adminExport?: boolean;
  recordCount?: number;
}

export async function createDataProtectionExport(
  payload: unknown,
  requestedBy = "ADMIN",
  opts: CreateExportOptions = {},
): Promise<{ exportId: string; redactedSample: unknown; envelopeHash: string }> {
  const exportId = `dpexp_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const { redacted, redactedKeys, status: redactionStatus } = redactForAudit(payload);

  // Phase 7 — build the trustworthy, redaction-aware export envelope and bind a
  // deterministic sha256 over its canonical serialization so the export's
  // provenance + redaction posture is verifiable after the fact.
  const envelope = buildExportEnvelopeMeta(
    {
      exportType: "REDACTED_JSON",
      requestedBy,
      requestedByRole: opts.requestedByRole ?? null,
      redactionStatus,
      redactedKeys,
      recordCount: opts.recordCount,
      adminExport: opts.adminExport === true,
    },
    exportId,
    createdAt,
  );
  const envelopeHash = createHash("sha256").update(canonicalExportPayload(envelope), "utf8").digest("hex");

  await db.insert(dataProtectionExportsTable).values({
    exportId, requestedBy, exportType: "REDACTED_JSON", status: "COMPLETED", redacted: true,
    metadata: {
      envelope,
      envelopeHash,
      redactionStatus,
      redactedKeys,
      sampleKeys: payload && typeof payload === "object" ? Object.keys(payload as Record<string, unknown>).slice(0, 20) : [],
    },
  });
  // Tamper-evident record of the export itself (best-effort, never blocks).
  await mirrorCriticalEvent({
    eventType: "AUDIT_EXPORT", severity: "HIGH", status: "ALLOWED",
    actorType: requestedBy, affectedObject: `data_protection_exports:${exportId}`,
    message: "Data protection export generated", metadata: { exportId, redactionStatus, envelopeHash },
  });
  return { exportId, redactedSample: redacted, envelopeHash };
}

export async function listDataProtectionExports(limit = 20) {
  return db.select().from(dataProtectionExportsTable).orderBy(desc(dataProtectionExportsTable.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
}

export async function getRoleByKey(roleKey: string) {
  const [r] = await db.select().from(securityRolesTable).where(eq(securityRolesTable.roleKey, roleKey.toUpperCase())).limit(1);
  return r ?? null;
}
