// Admin trading control routes.
//
// SAFETY:
// - All mutations require role ADMIN or OWNER.
// - Every mutation writes to admin_action_audit_log (append-only).
// - Switching platformMode to LIVE does NOT enable live execution on its own.
//   The order guard chain still rejects every order until Phase 3 ships the
//   broker placement layer (docs/PHASE3_BROKER_PLACEMENT.md).
// - Default state is fail-closed; this router never relaxes that without an
//   explicit, authenticated admin action with a reason.

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  globalTradingSettingsTable,
  userTradingPermissionsTable,
  userRiskLimitsTable,
  adminActionAuditLogTable,
  tradeCommandAuditLogTable,
  usersTable,
  mt5ConnectionTable,
  sharedMasterAccountsTable,
  virtualTradingAccountsTable,
  sharedTradeAttributionTable,
  alertDeliveryLogsTable,
  userNotificationsTable,
} from "@workspace/db/schema";
import { eq, desc, asc, and, gte, sql } from "drizzle-orm";
import { tradingModeGate } from "@workspace/db/repositories";
import {
  killSwitchReleaseViolations,
  postureFromSettingsRow,
} from "../lib/phase6/killSwitchReleasePolicy.js";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import { z } from "zod/v4";
import { getEnvelope, getGlobalSettings } from "../lib/adminTrading/safetyEnvelope.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";

const router: IRouter = Router();

function getAdminRole(req: Request): "ADMIN" | "OWNER" | null {
  // SECURITY: never trust the `x-security-role` header on its own — a logged-in
  // non-admin user could forge it. Authority is the validated session role on
  // `req.authUser` (set by attachAuthUser after verifying the session cookie).
  // The header is still accepted by the existing admin UI, but only as a hint
  // that must match the validated role (so the header can never elevate).
  const u = (req as Request & { authUser?: { role?: string } }).authUser;
  // Task #743 Cluster D — operator gate via the shared helper so INVESTOR/USER
  // sessions are denied identically across all admin/live-control routes.
  const sessionRole = operatorRoleFromSession(u?.role);
  if (!sessionRole) return null;
  const headerRole = String(req.header("x-security-role") ?? "").toUpperCase();
  if (headerRole && headerRole !== sessionRole && !(sessionRole === "OWNER" && headerRole === "ADMIN")) {
    return null;
  }
  return sessionRole as "ADMIN" | "OWNER";
}

function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const role = getAdminRole(req);
  if (!role) {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role;
}

async function writeAdminAudit(args: {
  adminId: number | null; adminRole: string; action: string;
  targetUserId?: number | null;
  beforeState?: Record<string, unknown>; afterState?: Record<string, unknown>;
  reason?: string | null; ipAddress?: string | null;
}) {
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.adminRole,
    action: args.action,
    targetUserId: args.targetUserId ?? null,
    beforeState: args.beforeState ?? {},
    afterState: args.afterState ?? {},
    reason: args.reason ?? null,
    ipAddress: args.ipAddress ?? null,
  });
}

// ─── Settings ───────────────────────────────────────────────────────────────

router.get("/admin/trading/settings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const settings = await getGlobalSettings();
  res.json({ ok: true, settings });
});

const modeSchema = z.object({
  platformMode: z.enum(["OFF", "SIMULATED", "DEMO", "LIVE"]),
  reason: z.string().min(3).optional(),
});

router.post("/admin/trading/mode", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const parsed = modeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message });
    return;
  }
  const before = await getGlobalSettings();
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_UNAVAILABLE" }); return; }

  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const next = parsed.data.platformMode;
  const updated = await db.update(globalTradingSettingsTable)
    .set({
      platformMode: next,
      demoEnabled: next === "DEMO" || next === "LIVE",
      liveEnabled: next === "LIVE",
      updatedByAdminId: adminId,
      updatedAt: new Date(),
    })
    .where(eq(globalTradingSettingsTable.id, before.id))
    .returning();

  await writeAdminAudit({
    adminId, adminRole: role, action: "SET_PLATFORM_MODE",
    beforeState: { platformMode: before.platformMode, demoEnabled: before.demoEnabled, liveEnabled: before.liveEnabled },
    afterState: { platformMode: next, demoEnabled: updated[0]?.demoEnabled, liveEnabled: updated[0]?.liveEnabled },
    reason: parsed.data.reason ?? null,
    ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, settings: updated[0] });
});

router.post("/admin/trading/emergency-kill", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const before = await getGlobalSettings();
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_UNAVAILABLE" }); return; }
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const reason = String((req.body as { reason?: string })?.reason ?? "").trim();
  if (reason.length < 4) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }

  const updated = await db.update(globalTradingSettingsTable)
    .set({
      emergencyKillSwitch: true,
      killSwitchEngagedAt: new Date(),
      killSwitchReason: reason,
      updatedByAdminId: adminId,
      updatedAt: new Date(),
    })
    .where(eq(globalTradingSettingsTable.id, before.id))
    .returning();
  await writeAdminAudit({
    adminId, adminRole: role, action: "ENGAGE_KILL_SWITCH",
    beforeState: { emergencyKillSwitch: before.emergencyKillSwitch },
    afterState: { emergencyKillSwitch: true },
    reason, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, settings: updated[0] });
});

router.post("/admin/trading/reset-kill", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const before = await getGlobalSettings();
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_UNAVAILABLE" }); return; }
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const reason = String((req.body as { reason?: string })?.reason ?? "").trim();
  if (reason.length < 4) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }

  // Releasing the emergency stop is subject to the SAME cold-platform wall as
  // the live-shared RELEASE doorway. Before this check, this route was a third
  // writer that bypassed both release ceremonies with nothing but an admin
  // session and four characters of prose — while any live control is hot,
  // release must go through the full activate-step ceremony instead.
  const releaseViolations = killSwitchReleaseViolations(
    postureFromSettingsRow(before, liveBrokerExecutionEnabled()),
  );
  if (releaseViolations.length > 0) {
    res.status(409).json({
      ok: false,
      error: "COLD_POSTURE_REQUIRED_FOR_RELEASE",
      violations: releaseViolations,
      detail:
        "The kill switch may only be reset while every live control is off. Releasing while a " +
        "listed control is hot requires the shared-live activation ceremony " +
        "(POST /api/admin/live-shared/activate-step).",
    });
    return;
  }

  const updated = await db.update(globalTradingSettingsTable)
    .set({
      emergencyKillSwitch: false,
      killSwitchEngagedAt: null,
      killSwitchReason: null,
      updatedByAdminId: adminId,
      updatedAt: new Date(),
    })
    .where(eq(globalTradingSettingsTable.id, before.id))
    .returning();
  await writeAdminAudit({
    adminId, adminRole: role, action: "RESET_KILL_SWITCH",
    beforeState: { emergencyKillSwitch: before.emergencyKillSwitch },
    afterState: { emergencyKillSwitch: false },
    reason, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, settings: updated[0] });
});

// ─── Per-user ───────────────────────────────────────────────────────────────

router.get("/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const users = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role,
  }).from(usersTable).orderBy(asc(usersTable.id));
  const perms = await db.select().from(userTradingPermissionsTable);
  const permsByUser = new Map(perms.map((p) => [p.userId, p]));
  res.json({
    ok: true,
    users: users.map((u) => ({ ...u, permissions: permsByUser.get(u.id) ?? null })),
  });
});

const userPermSchema = z.object({
  tradingMode: z.enum(["DISABLED", "SIMULATED", "DEMO", "LIVE"]).optional(),
  demoEnabled: z.boolean().optional(),
  liveApproved: z.boolean().optional(),
  liveEnabled: z.boolean().optional(),
  suspended: z.boolean().optional(),
  suspensionReason: z.string().optional(),
  reason: z.string().min(3).optional(),
  confirmPhrase: z.string().optional(),
});

router.post("/admin/users/:id/permissions", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const targetUserId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetUserId)) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = userPermSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY" }); return; }
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;

  const existing = await db.select().from(userTradingPermissionsTable)
    .where(eq(userTradingPermissionsTable.userId, targetUserId)).limit(1);
  const before = existing[0] ?? null;

  // LIVE escalation requires typed phrase + non-trivial operator reason.
  const gate = tradingModeGate.validateModeChangeRequest({
    before: before ? { tradingMode: before.tradingMode } : null,
    requestedMode: parsed.data.tradingMode,
    reason: parsed.data.reason,
    confirmPhrase: parsed.data.confirmPhrase,
  });
  if (!gate.ok) { res.status(403).json({ ok: false, error: gate.error, message: gate.message }); return; }
  const modePatch = tradingModeGate.buildModeChangePatch({
    before: before ? { tradingMode: before.tradingMode } : null,
    requestedMode: parsed.data.tradingMode,
    reason: parsed.data.reason,
  });

  const patch = {
    userId: targetUserId,
    tradingMode: parsed.data.tradingMode ?? before?.tradingMode ?? "DISABLED",
    demoEnabled: parsed.data.demoEnabled ?? before?.demoEnabled ?? false,
    liveApproved: parsed.data.liveApproved ?? before?.liveApproved ?? false,
    liveEnabled: parsed.data.liveEnabled ?? before?.liveEnabled ?? false,
    suspended: parsed.data.suspended ?? before?.suspended ?? true,
    suspensionReason: parsed.data.suspensionReason ?? before?.suspensionReason ?? null,
    ...(modePatch.previousTradingMode !== null ? {
      previousTradingMode: modePatch.previousTradingMode,
      tradingModeUpdatedAt: modePatch.tradingModeUpdatedAt,
      tradingModeChangeReason: modePatch.tradingModeChangeReason,
    } : {}),
    updatedByAdminId: adminId,
    updatedAt: new Date(),
  };

  let row;
  if (before) {
    const r = await db.update(userTradingPermissionsTable).set(patch)
      .where(eq(userTradingPermissionsTable.userId, targetUserId)).returning();
    row = r[0];
  } else {
    const r = await db.insert(userTradingPermissionsTable).values(patch).returning();
    row = r[0];
  }

  const action =
    parsed.data.suspended === true ? "SUSPEND_USER" :
    parsed.data.suspended === false ? "REINSTATE_USER" :
    parsed.data.liveApproved === true ? "APPROVE_LIVE" :
    "SET_USER_MODE";

  await writeAdminAudit({
    adminId, adminRole: role, action, targetUserId,
    beforeState: before ? { ...before } : {},
    afterState: row ? { ...row } : {},
    reason: parsed.data.reason ?? null,
    ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, permissions: row });
});

const riskLimitsSchema = z.object({
  maxLotSize: z.number().min(0.01).max(100),
  maxTradesPerDay: z.number().int().min(0).max(1000),
  maxDailyLossUsd: z.number().min(0),
  allowedSymbols: z.array(z.string()).default([]),
  allowedAccountType: z.enum(["demo", "live", "both"]).default("demo"),
  allowedDirection: z.enum(["buy", "sell", "both"]).default("both"),
  requireLiveConfirmation: z.boolean().default(true),
  reason: z.string().min(3).optional(),
});

router.post("/admin/users/:id/risk-limits", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const targetUserId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetUserId)) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = riskLimitsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message }); return; }
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;

  const before = (await db.select().from(userRiskLimitsTable)
    .where(eq(userRiskLimitsTable.userId, targetUserId)).limit(1))[0] ?? null;

  const patch = {
    userId: targetUserId,
    maxLotSize: parsed.data.maxLotSize,
    maxTradesPerDay: parsed.data.maxTradesPerDay,
    maxDailyLossUsd: parsed.data.maxDailyLossUsd,
    allowedSymbols: parsed.data.allowedSymbols,
    allowedAccountType: parsed.data.allowedAccountType,
    allowedDirection: parsed.data.allowedDirection,
    requireLiveConfirmation: parsed.data.requireLiveConfirmation,
    updatedByAdminId: adminId,
    updatedAt: new Date(),
  };

  let row;
  if (before) {
    const r = await db.update(userRiskLimitsTable).set(patch)
      .where(eq(userRiskLimitsTable.userId, targetUserId)).returning();
    row = r[0];
  } else {
    const r = await db.insert(userRiskLimitsTable).values(patch).returning();
    row = r[0];
  }
  await writeAdminAudit({
    adminId, adminRole: role, action: "SET_RISK_LIMITS", targetUserId,
    beforeState: before ? { ...before } : {},
    afterState: row ? { ...row } : {},
    reason: parsed.data.reason ?? null,
    ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, limits: row });
});

// ─── Audit logs ─────────────────────────────────────────────────────────────

router.get("/admin/audit/trades", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  const rows = await db.select().from(tradeCommandAuditLogTable)
    .orderBy(desc(tradeCommandAuditLogTable.createdAt)).limit(limit);
  res.json({ ok: true, count: rows.length, events: rows });
});

router.get("/admin/audit/admin-actions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  const rows = await db.select().from(adminActionAuditLogTable)
    .orderBy(desc(adminActionAuditLogTable.createdAt)).limit(limit);
  res.json({ ok: true, count: rows.length, events: rows });
});

// ─── Phase UX9 — Admin execution-health monitor ─────────────────────────────
//
// SAFETY: returns aggregate execution metrics + 20 most recent results.
// Reads only — no secrets, no master credentials, no per-user PII beyond
// userId/symbol that admin already sees via /admin/audit/trades.
router.get("/admin/trading/execution-health", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tradeActionRequestsTable } = await import("@workspace/db/schema");
  const recent = await db.select().from(tradeActionRequestsTable)
    .orderBy(desc(tradeActionRequestsTable.updatedAt))
    .limit(100);
  const recent20 = recent.slice(0, 20).map((r) => ({
    id: r.id, userId: r.userId, actionType: r.actionType, status: r.status,
    symbol: r.symbol, requestedMode: r.requestedMode,
    mt5OrderTicket: r.mt5OrderTicket ?? null, mt5PositionTicket: r.mt5PositionTicket ?? null,
    fillPrice: r.fillPrice ?? null, slippage: r.slippage ?? null,
    filledLotSize: r.filledLotSize ?? null, brokerMessage: r.brokerMessage ?? null,
    errorCode: r.errorCode ?? null, rejectionReason: r.rejectionReason ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
  const terminal = recent.filter((r) => ["executed", "rejected", "failed", "expired", "cancelled"].includes(r.status));
  const executedCount = terminal.filter((r) => r.status === "executed").length;
  const rejectedCount = terminal.filter((r) => r.status === "rejected").length;
  const failedCount = terminal.filter((r) => r.status === "failed").length;
  const stuckCount = recent.filter((r) => r.errorCode === "WATCHDOG_STALE").length;
  const rejectionRate = terminal.length > 0 ? (rejectedCount + failedCount) / terminal.length : 0;
  res.json({
    ok: true,
    recent: recent20,
    metrics: {
      sampleSize: terminal.length,
      executed: executedCount,
      rejected: rejectedCount,
      failed: failedCount,
      stuck: stuckCount,
      rejectionRate: Number(rejectionRate.toFixed(4)),
    },
  });
});

// ─── Phase 3.5 — Account Routing Mode ───────────────────────────────────────
//
// SAFETY: switching routingMode affects NEW orders only. Open trades and
// queued commands keep their original routing. Shared LIVE requires a
// separate explicit flag (sharedLiveTradingEnabled). Master credentials
// (apiKeyHash / tokenLast4 / serverName) are NEVER returned by any of
// these endpoints — only id + masked display.

const routingModeSchema = z.object({
  accountRoutingMode: z.enum(["USER_OWNED_MT5", "SHARED_MASTER_MT5"]),
  reason: z.string().min(4),
});
router.post("/admin/trading/routing-mode", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const parsed = routingModeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message }); return; }
  const before = await getGlobalSettings();
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_UNAVAILABLE" }); return; }
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const updated = await db.update(globalTradingSettingsTable)
    .set({ accountRoutingMode: parsed.data.accountRoutingMode,
      updatedByAdminId: adminId, updatedAt: new Date() })
    .where(eq(globalTradingSettingsTable.id, before.id))
    .returning();
  await writeAdminAudit({
    adminId, adminRole: role, action: "SET_ACCOUNT_ROUTING_MODE",
    beforeState: { accountRoutingMode: before.accountRoutingMode },
    afterState: { accountRoutingMode: parsed.data.accountRoutingMode },
    reason: parsed.data.reason, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, settings: updated[0] });
});

const sharedLiveEnabledSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(4),
});
router.post("/admin/trading/shared-live-enabled", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  // OWNER required to flip the explicit live flag — admins can configure
  // everything else but only the owner authorises shared real-money trading.
  if (role !== "OWNER") { res.status(403).json({ ok: false, error: "OWNER_REQUIRED_FOR_SHARED_LIVE" }); return; }
  const parsed = sharedLiveEnabledSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY" }); return; }
  const before = await getGlobalSettings();
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_UNAVAILABLE" }); return; }
  if (parsed.data.enabled && !before.sharedLiveConnectionId) {
    res.status(400).json({ ok: false, error: "SHARED_LIVE_MASTER_NOT_CONFIGURED" });
    return;
  }
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const updated = await db.update(globalTradingSettingsTable)
    .set({ sharedLiveTradingEnabled: parsed.data.enabled,
      updatedByAdminId: adminId, updatedAt: new Date() })
    .where(eq(globalTradingSettingsTable.id, before.id))
    .returning();
  await writeAdminAudit({
    adminId, adminRole: role,
    action: parsed.data.enabled ? "ENABLE_SHARED_LIVE_TRADING" : "DISABLE_SHARED_LIVE_TRADING",
    beforeState: { sharedLiveTradingEnabled: before.sharedLiveTradingEnabled },
    afterState: { sharedLiveTradingEnabled: parsed.data.enabled },
    reason: parsed.data.reason, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, settings: updated[0] });
});

const sharedMasterSchema = z.object({
  connectionId: z.number().int().positive(),
  accountType: z.enum(["demo", "live"]),
  isActive: z.boolean().default(true),
  brokerName: z.string().optional(),
  accountNumberMasked: z.string().optional(),
  reason: z.string().min(4),
});
// Register an existing mt5_connection (owned by an ADMIN/OWNER) as the
// shared master for DEMO or LIVE, and set it as the current selection on
// global_trading_settings. The actual broker credentials never leave the
// mt5_connection row.
router.post("/admin/trading/shared-master", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const parsed = sharedMasterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: parsed.error.message }); return; }

  const [conn] = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, parsed.data.connectionId)).limit(1);
  if (!conn || conn.userId == null) {
    res.status(404).json({ ok: false, error: "CONNECTION_NOT_FOUND" }); return;
  }
  const connOwnerId: number = conn.userId;

  // The owning user of the master connection must be ADMIN or OWNER.
  const [owner] = await db.select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, connOwnerId)).limit(1);
  if (!owner || (owner.role !== "ADMIN" && owner.role !== "OWNER")) {
    res.status(400).json({ ok: false, error: "MASTER_CONNECTION_MUST_BE_OWNED_BY_ADMIN_OR_OWNER" });
    return;
  }
  const connAccountType = String((conn as { accountType?: string | null }).accountType ?? "").toLowerCase();
  const wantedType = parsed.data.accountType;
  const matches = (wantedType === "demo" && connAccountType === "demo")
    || (wantedType === "live" && (connAccountType === "live" || connAccountType === "real"));
  if (!matches) {
    res.status(400).json({ ok: false, error: "CONNECTION_ACCOUNT_TYPE_MISMATCH",
      connectionAccountType: connAccountType, wanted: wantedType });
    return;
  }

  // Upsert the shared_master_accounts row for this connection.
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  const [existing] = await db.select().from(sharedMasterAccountsTable)
    .where(eq(sharedMasterAccountsTable.connectionId, parsed.data.connectionId)).limit(1);

  const masked = parsed.data.accountNumberMasked
    ?? (conn.accountNumber ? `•••• ${String(conn.accountNumber).slice(-4)}` : null);

  let smRow;
  if (existing) {
    const r = await db.update(sharedMasterAccountsTable).set({
      accountType: wantedType,
      brokerName: parsed.data.brokerName ?? conn.brokerName ?? existing.brokerName,
      accountNumberMasked: masked,
      isActive: parsed.data.isActive,
      status: parsed.data.isActive ? "active" : "inactive",
      updatedAt: new Date(),
    }).where(eq(sharedMasterAccountsTable.id, existing.id)).returning();
    smRow = r[0];
  } else {
    const r = await db.insert(sharedMasterAccountsTable).values({
      connectionId: parsed.data.connectionId,
      accountType: wantedType,
      brokerName: parsed.data.brokerName ?? conn.brokerName ?? null,
      accountNumberMasked: masked,
      isActive: parsed.data.isActive,
      status: parsed.data.isActive ? "active" : "inactive",
      createdByAdminId: adminId,
    }).returning();
    smRow = r[0];
  }

  // Wire it as the active demo or live master on the global settings.
  const before = await getGlobalSettings();
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_UNAVAILABLE" }); return; }
  const patch = wantedType === "demo"
    ? { sharedDemoConnectionId: parsed.data.isActive ? parsed.data.connectionId : null }
    : { sharedLiveConnectionId: parsed.data.isActive ? parsed.data.connectionId : null };
  const updated = await db.update(globalTradingSettingsTable)
    .set({ ...patch, updatedByAdminId: adminId, updatedAt: new Date() })
    .where(eq(globalTradingSettingsTable.id, before.id))
    .returning();

  await writeAdminAudit({
    adminId, adminRole: role,
    action: `SET_SHARED_${wantedType.toUpperCase()}_MASTER`,
    beforeState: {
      sharedDemoConnectionId: before.sharedDemoConnectionId,
      sharedLiveConnectionId: before.sharedLiveConnectionId,
    },
    afterState: {
      sharedDemoConnectionId: updated[0]?.sharedDemoConnectionId ?? null,
      sharedLiveConnectionId: updated[0]?.sharedLiveConnectionId ?? null,
      sharedMasterAccountId: smRow?.id ?? null,
    },
    reason: parsed.data.reason, ipAddress: req.ip ?? null,
  });

  res.json({ ok: true, sharedMaster: smRow, settings: updated[0] });
});

// List candidate master connections (any mt5_connection owned by an ADMIN
// or OWNER user). Credentials are NEVER included.
router.get("/admin/shared-masters", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const admins = await db.select({ id: usersTable.id, role: usersTable.role, email: usersTable.email })
    .from(usersTable);
  const adminIds = admins.filter((u) => u.role === "ADMIN" || u.role === "OWNER").map((u) => u.id);

  const conns = adminIds.length === 0 ? [] : await db.select().from(mt5ConnectionTable);
  const candidates = conns
    .filter((c) => c.userId != null && adminIds.includes(c.userId))
    .map((c) => ({
      connectionId: c.id,
      ownerUserId: c.userId as number,
      connectionName: c.connectionName,
      brokerName: c.brokerName,
      accountType: (c as { accountType?: string | null }).accountType ?? "unknown",
      accountNumberMasked: c.accountNumber ? `•••• ${String(c.accountNumber).slice(-4)}` : null,
      status: c.status,
      lastHeartbeat: c.lastHeartbeat,
    }));

  const registered = await db.select().from(sharedMasterAccountsTable);
  const settings = await getGlobalSettings();
  res.json({
    ok: true,
    activeDemoConnectionId: settings?.sharedDemoConnectionId ?? null,
    activeLiveConnectionId: settings?.sharedLiveConnectionId ?? null,
    sharedLiveTradingEnabled: !!settings?.sharedLiveTradingEnabled,
    candidates,
    registered: registered.map((r) => ({
      id: r.id, connectionId: r.connectionId, accountType: r.accountType,
      brokerName: r.brokerName, accountNumberMasked: r.accountNumberMasked,
      status: r.status, isActive: r.isActive,
    })),
  });
});

router.get("/admin/virtual-accounts", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const parsedUserId = req.query.userId ? parseInt(String(req.query.userId), 10) : NaN;
  const userIdQ: number | null = Number.isFinite(parsedUserId) ? parsedUserId : null;
  const rows = userIdQ !== null
    ? await db.select().from(virtualTradingAccountsTable)
        .where(eq(virtualTradingAccountsTable.userId, userIdQ))
        .orderBy(desc(virtualTradingAccountsTable.updatedAt))
    : await db.select().from(virtualTradingAccountsTable)
        .orderBy(desc(virtualTradingAccountsTable.updatedAt));
  res.json({ ok: true, count: rows.length, accounts: rows });
});

router.get("/admin/audit/attribution", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1000);
  const parsedUserId = req.query.userId ? parseInt(String(req.query.userId), 10) : NaN;
  const userIdQ: number | null = Number.isFinite(parsedUserId) ? parsedUserId : null;
  const rows = userIdQ !== null
    ? await db.select().from(sharedTradeAttributionTable)
        .where(eq(sharedTradeAttributionTable.userId, userIdQ))
        .orderBy(desc(sharedTradeAttributionTable.createdAt)).limit(limit)
    : await db.select().from(sharedTradeAttributionTable)
        .orderBy(desc(sharedTradeAttributionTable.createdAt)).limit(limit);
  res.json({ ok: true, count: rows.length, events: rows });
});

const userRoutingOverrideSchema = z.object({
  accountRoutingOverride: z.enum(["inherit", "USER_OWNED_MT5", "SHARED_MASTER_MT5"]),
  reason: z.string().min(4),
});
router.post("/admin/users/:id/routing-override", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const targetUserId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetUserId)) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = userRoutingOverrideSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: "INVALID_BODY" }); return; }

  // Normalize to the storage value used by routingResolver.ts (lowercase
  // for non-inherit; 'inherit' as-is).
  const stored = parsed.data.accountRoutingOverride === "inherit"
    ? "inherit"
    : parsed.data.accountRoutingOverride.toLowerCase();

  const [before] = await db.select().from(userTradingPermissionsTable)
    .where(eq(userTradingPermissionsTable.userId, targetUserId)).limit(1);
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;

  let row;
  if (before) {
    const r = await db.update(userTradingPermissionsTable)
      .set({ accountRoutingOverride: stored, updatedByAdminId: adminId, updatedAt: new Date() })
      .where(eq(userTradingPermissionsTable.userId, targetUserId)).returning();
    row = r[0];
  } else {
    const r = await db.insert(userTradingPermissionsTable).values({
      userId: targetUserId, accountRoutingOverride: stored,
      updatedByAdminId: adminId,
    }).returning();
    row = r[0];
  }

  await writeAdminAudit({
    adminId, adminRole: role, action: "SET_USER_ROUTING_OVERRIDE", targetUserId,
    beforeState: { accountRoutingOverride: before?.accountRoutingOverride ?? "inherit" },
    afterState: { accountRoutingOverride: stored },
    reason: parsed.data.reason, ipAddress: req.ip ?? null,
  });

  res.json({ ok: true, permissions: row });
});

// ── Multi-User Trade Queue: cancel-queued + mark-needs-review ─────────
// Admin-only queue controls for arx_live_commands. Used by operators
// when a command is stuck in a pre-dispatch state (LIVE_DRAFT,
// LIVE_CONFIRMATION_REQUIRED, LIVE_APPROVED, LIVE_BLOCKED) and either
// needs to be cancelled before reaching the EA or escalated for human
// review.
//
// SAFETY:
// - requireAdmin enforced at route entry.
// - Cancel REFUSES once status >= SENT_TO_MT5_LIVE (the EA already
//   picked it up — the only safe path is reconciliation, not cancel).
// - Mark-NEEDS_REVIEW writes audit + sets status; never reverses a
//   terminal state.
// - Both write to adminActionAuditLogTable (append-only forensic trail).
// - Neither endpoint dispatches a new live command. No new
//   arx_live_commands row is ever inserted by these endpoints.
// Cancellable pre-dispatch statuses. Once the EA has picked up the
// command (SENT_TO_MT5_LIVE or later) the only safe path is
// reconciliation, never cancel.
const LIVE_CANCELLABLE_STATUSES = [
  "LIVE_DRAFT", "LIVE_CONFIRMATION_REQUIRED", "LIVE_APPROVED", "LIVE_BLOCKED",
] as const;
// Terminal statuses that block mark-needs-review escalation.
const LIVE_TERMINAL_STATUSES = [
  "LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_CANCELLED", "LIVE_CLOSED",
] as const;

router.post("/admin/trading/commands/:commandId/cancel-queued", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const { arxLiveCommandsTable } = await import("@workspace/db/schema");
  const { inArray } = await import("drizzle-orm");
  const commandId = String(req.params.commandId);
  // Atomic guarded UPDATE — only mutates rows whose status is still in
  // the cancellable set at the moment of the write. Prevents TOCTOU
  // (e.g. EA pulling between a separate SELECT and UPDATE).
  const updated = await db.update(arxLiveCommandsTable)
    .set({ status: "LIVE_CANCELLED", rejectionReason: "ADMIN_CANCELLED_QUEUED" })
    .where(and(
      eq(arxLiveCommandsTable.commandId, commandId),
      inArray(arxLiveCommandsTable.status, LIVE_CANCELLABLE_STATUSES as unknown as string[]),
    ))
    .returning();
  if (updated.length === 0) {
    // Disambiguate: row missing vs row exists but not cancellable.
    const [existing] = await db.select().from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, commandId)).limit(1);
    if (!existing) { res.status(404).json({ ok: false, error: "COMMAND_NOT_FOUND" }); return; }
    res.status(409).json({ ok: false, error: "COMMAND_NOT_CANCELLABLE", currentStatus: existing.status,
      message: "Command has already been sent to the bridge or reached a terminal state." });
    return;
  }
  const after = updated[0]!;
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  await writeAdminAudit({
    adminId, adminRole: role, action: "CANCEL_QUEUED_LIVE_COMMAND",
    targetUserId: after.userId,
    beforeState: { commandId, statusGuard: LIVE_CANCELLABLE_STATUSES },
    afterState: { commandId, status: after.status },
    reason: (req.body ?? {}).reason ?? null, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, command: { commandId, status: after.status } });
});

router.post("/admin/trading/commands/:commandId/mark-needs-review", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const { arxLiveCommandsTable } = await import("@workspace/db/schema");
  const { not, inArray } = await import("drizzle-orm");
  const commandId = String(req.params.commandId);
  // Atomic guarded UPDATE — only mutates rows whose status is NOT in
  // any terminal state at the moment of the write. Prevents TOCTOU
  // (e.g. EA fill-result landing between a separate SELECT and UPDATE).
  const updated = await db.update(arxLiveCommandsTable)
    .set({ status: "NEEDS_REVIEW", rejectionReason: "ADMIN_MARKED_NEEDS_REVIEW" })
    .where(and(
      eq(arxLiveCommandsTable.commandId, commandId),
      not(inArray(arxLiveCommandsTable.status, LIVE_TERMINAL_STATUSES as unknown as string[])),
    ))
    .returning();
  if (updated.length === 0) {
    const [existing] = await db.select().from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, commandId)).limit(1);
    if (!existing) { res.status(404).json({ ok: false, error: "COMMAND_NOT_FOUND" }); return; }
    res.status(409).json({ ok: false, error: "COMMAND_TERMINAL", currentStatus: existing.status,
      message: "Command is already in a terminal state — cannot mark for review." });
    return;
  }
  const after = updated[0]!;
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  await writeAdminAudit({
    adminId, adminRole: role, action: "MARK_LIVE_COMMAND_NEEDS_REVIEW",
    targetUserId: after.userId,
    beforeState: { commandId, terminalGuard: LIVE_TERMINAL_STATUSES },
    afterState: { commandId, status: after.status },
    reason: (req.body ?? {}).reason ?? null, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, command: { commandId, status: after.status } });
});

// ── UX4 — Trade Monitor admin controls ────────────────────────────────
// Read-only status + global pause toggle. The monitor itself is paper-only
// (it only writes intelligence snapshots, alerts, notifications, timeline);
// it never executes a trade. Pausing it only stops alert generation — the
// emergency kill switch is the canonical guard for order placement and is
// already enforced upstream.
router.get("/admin/trade-monitor", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { getMonitorStatus, isGloballyPaused } = await import("../lib/intelligence/monitorWorker.js");
  const status = getMonitorStatus();
  res.json({ ok: true, status, paused: isGloballyPaused() });
});

router.post("/admin/trade-monitor/pause", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const paused = Boolean((req.body ?? {}).paused);
  const { setGlobalPause, getMonitorStatus } = await import("../lib/intelligence/monitorWorker.js");
  setGlobalPause(paused);
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  await writeAdminAudit({
    adminId, adminRole: role, action: paused ? "PAUSE_TRADE_MONITOR" : "RESUME_TRADE_MONITOR",
    targetUserId: null,
    beforeState: { paused: !paused }, afterState: { paused },
    reason: (req.body ?? {}).reason ?? null, ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, paused, status: getMonitorStatus() });
});

// ── Unified Alerts QA-fix: admin Alert Health + test-send ─────────────
// Read-only overview surfaced on the admin Trading Control page so operators
// can see real delivery health (in-app + push, success / failed / revoked /
// skipped) for the last 24h, plus a controlled test-send that exercises the
// in-app + push pipeline end-to-end against the calling admin only.
// SAFETY:
// - Admin-only (requireAdmin + writeAdminAudit).
// - Test alert is targeted at the admin's own userId — never at another user.
// - Never returns subscription endpoints, VAPID keys, or raw failure bodies;
//   only the short-coded counts already stored in alert_delivery_logs.
router.get("/admin/alerts/overview", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sinceDay = new Date(Date.now() - 24 * 60 * 60_000);
  const sinceHour = new Date(Date.now() - 60 * 60_000);

  const byChannelStatus = await db
    .select({
      channel: alertDeliveryLogsTable.deliveryChannel,
      status: alertDeliveryLogsTable.deliveryStatus,
      count: sql<number>`COUNT(*)`.mapWith(Number),
    })
    .from(alertDeliveryLogsTable)
    .where(gte(alertDeliveryLogsTable.createdAt, sinceDay))
    .groupBy(alertDeliveryLogsTable.deliveryChannel, alertDeliveryLogsTable.deliveryStatus);

  const recentFailures = await db
    .select({
      id: alertDeliveryLogsTable.id,
      userId: alertDeliveryLogsTable.userId,
      channel: alertDeliveryLogsTable.deliveryChannel,
      status: alertDeliveryLogsTable.deliveryStatus,
      failureReason: alertDeliveryLogsTable.failureReason,
      severity: alertDeliveryLogsTable.severity,
      category: alertDeliveryLogsTable.category,
      createdAt: alertDeliveryLogsTable.createdAt,
    })
    .from(alertDeliveryLogsTable)
    .where(and(
      gte(alertDeliveryLogsTable.createdAt, sinceDay),
      sql`${alertDeliveryLogsTable.deliveryStatus} IN ('failed','revoked')`,
    ))
    .orderBy(desc(alertDeliveryLogsTable.createdAt))
    .limit(20);

  const criticalLastHour = await db
    .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(userNotificationsTable)
    .where(and(
      eq(userNotificationsTable.severity, "critical"),
      gte(userNotificationsTable.createdAt, sinceHour),
    ));

  res.json({
    ok: true,
    pushSystem: {
      vapidConfigured: Boolean(process.env["VAPID_PUBLIC_KEY"] && process.env["VAPID_PRIVATE_KEY"]),
    },
    deliveryByChannelStatus: byChannelStatus,
    criticalAlertsLastHour: Number(criticalLastHour[0]?.count ?? 0),
    recentFailures,
    safetyMode: "paper_only",
    liveLocked: true,
  });
});

router.post("/admin/alerts/test", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const adminId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
  if (!adminId) { res.status(401).json({ ok: false, error: "admin user id missing" }); return; }

  const { fireNotify } = await import("../lib/notificationService.js");
  fireNotify(adminId,
    {
      notificationType: "system",
      severity: "info",
      title: "ARX AI test alert",
      message: "Admin test alert — confirms the unified alert pipeline is alive.",
      source: "system",
      entityType: "admin_test",
      entityId: null,
      actionLabel: "View notifications",
      actionTarget: "/notifications",
    },
    {
      eventType: "admin_test_alert_sent",
      title: "Admin test alert sent",
      description: "Operator-issued unified-alert pipeline test.",
      source: "system",
      entityType: "admin_test",
      entityId: null,
    },
  );

  await writeAdminAudit({
    adminId, adminRole: role, action: "SEND_ADMIN_TEST_ALERT", targetUserId: adminId,
    beforeState: {}, afterState: { targetUserId: adminId },
    reason: (req.body ?? {}).reason ?? "operator alert pipeline test", ipAddress: req.ip ?? null,
  });

  res.json({ ok: true, deliveredTo: adminId });
});


// ── Phase Playbook — Admin controls for Strategy Playbook & Setup Quality ──
// Read-only view + audited write of global playbook enforcement settings.
router.get("/admin/playbook/settings", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  const { playbookAdminSettingsTable, userPlaybooksTable } = await import("@workspace/db/schema");
  const [row] = await db.select().from(playbookAdminSettingsTable)
    .orderBy(desc(playbookAdminSettingsTable.updatedAt)).limit(1);
  const settings = row ?? {
    id: 0,
    playbookEnforcementEnabled: true, requireSetupBeforeLive: false,
    disabledTemplates: [] as string[], setupRiskWarnings: [] as Array<{ setupType: string; warning: string; severity: string }>,
    updatedBy: null, updatedReason: null, updatedAt: null, createdAt: null,
  };
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(userPlaybooksTable);
  res.json({ ok: true, settings, totalUserPlaybooks: Number(count), source: row ? "db" : "defaults" });
});

router.post("/admin/playbook/settings", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  const adminId = req.authUser!.id;
  const { playbookAdminSettingsTable } = await import("@workspace/db/schema");
  const body = (req.body ?? {}) as {
    playbookEnforcementEnabled?: boolean; requireSetupBeforeLive?: boolean;
    disabledTemplates?: string[]; setupRiskWarnings?: Array<{ setupType: string; warning: string; severity: string }>;
    reason?: string;
  };
  const [before] = await db.select().from(playbookAdminSettingsTable)
    .orderBy(desc(playbookAdminSettingsTable.updatedAt)).limit(1);
  const next = {
    playbookEnforcementEnabled: typeof body.playbookEnforcementEnabled === "boolean" ? body.playbookEnforcementEnabled : (before?.playbookEnforcementEnabled ?? true),
    requireSetupBeforeLive: typeof body.requireSetupBeforeLive === "boolean" ? body.requireSetupBeforeLive : (before?.requireSetupBeforeLive ?? false),
    disabledTemplates: Array.isArray(body.disabledTemplates) ? body.disabledTemplates.slice(0, 50).map(String) : (before?.disabledTemplates ?? []),
    setupRiskWarnings: Array.isArray(body.setupRiskWarnings) ? body.setupRiskWarnings.slice(0, 50) : (before?.setupRiskWarnings ?? []),
    updatedBy: adminId, updatedReason: (body.reason ?? "").slice(0, 500) || null,
    updatedAt: new Date(),
  };
  const [ins] = await db.insert(playbookAdminSettingsTable).values(next).returning();
  await writeAdminAudit({
    adminId, adminRole: role, action: "UPDATE_PLAYBOOK_SETTINGS", targetUserId: null,
    beforeState: before ? (before as unknown as Record<string, unknown>) : {},
    afterState: ins as unknown as Record<string, unknown>,
    reason: body.reason ?? "playbook enforcement settings update", ipAddress: req.ip ?? null,
  });
  res.json({ ok: true, settings: ins });
});

export default router;
