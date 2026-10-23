// Admin — One-Click Trading Permission Controls (Task #353)
//
// Routes:
//   GET  /api/admin/one-click/shared-bridge-users
//        — list all shared-bridge users with their one-click permission
//          + armed state (redacted: no bridge tokens, no account numbers)
//   POST /api/admin/one-click/users/:userId/grant
//        — grant one-click permission for a shared-bridge user
//          Body: { reason: string }
//   POST /api/admin/one-click/users/:userId/revoke
//        — revoke permission and auto-disarm the user
//          Body: { reason: string }
//
// SECURITY:
//   - Every handler is requireAdmin (ADMIN or OWNER only).
//   - Admin previewing-as-user lands in the 403 branch (effective role check).
//   - Every mutation writes a master_live_access_audit + one_click_audit row.
//   - No endpoint reveals bridge tokens, apiKeyHash, or raw account numbers.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  userMasterLiveAccessTable,
  masterLiveAccessAuditTable,
  userOneClickSettingsTable,
  oneClickAuditTable,
  globalTradingSettingsTable,
  mt5ConnectionTable,
} from "@workspace/db";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

async function writeMasterLiveAudit(args: {
  adminUserId: number;
  targetUserId: number;
  action: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(masterLiveAccessAuditTable).values({
    adminUserId: args.adminUserId,
    targetUserId: args.targetUserId,
    action: args.action,
    reason: args.reason ?? null,
    metadata: args.metadata ?? {},
  });
}

async function writeOneClickAudit(args: {
  userId: number;
  action: string;
  metadata?: unknown;
}): Promise<void> {
  await db.insert(oneClickAuditTable).values({
    userId: args.userId,
    action: args.action,
    metadata: args.metadata != null ? JSON.stringify(args.metadata) : null,
  });
}

/**
 * GET /api/admin/one-click/shared-bridge-users
 *
 * Returns a list of shared-bridge users (those approved for master live)
 * with their one-click permission state and armed status.
 */
router.get("/admin/one-click/shared-bridge-users", async (req: Request, res: Response) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  // Determine whether this environment is in SHARED_MASTER_MT5 routing mode.
  // Only shared-bridge users (those without their own mt5Connection row) are
  // relevant for this page — own-bridge users self-arm independently.
  const [globalSettings] = await db.select({
    accountRoutingMode: globalTradingSettingsTable.accountRoutingMode,
  }).from(globalTradingSettingsTable).limit(1);
  const isSharedMode = globalSettings?.accountRoutingMode === "SHARED_MASTER_MT5";

  // Fetch all own-bridge user IDs so we can exclude them.
  const ownBridgeRows = await db.select({ userId: mt5ConnectionTable.userId })
    .from(mt5ConnectionTable);
  const ownBridgeUserIds = new Set(ownBridgeRows.map((r) => r.userId));

  const rows = await db
    .select({
      userId: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      masterLiveStatus: userMasterLiveAccessTable.masterLiveStatus,
      approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
      sharedBridgeOneClickPermitted: userMasterLiveAccessTable.sharedBridgeOneClickPermitted,
      sharedBridgeOneClickPermittedAt: userMasterLiveAccessTable.sharedBridgeOneClickPermittedAt,
      sharedBridgeOneClickRevokedAt: userMasterLiveAccessTable.sharedBridgeOneClickRevokedAt,
    })
    .from(userMasterLiveAccessTable)
    .innerJoin(usersTable, eq(usersTable.id, userMasterLiveAccessTable.userId))
    .orderBy(desc(userMasterLiveAccessTable.updatedAt));

  // Filter to shared-bridge users only: system is in SHARED mode AND user has no own bridge.
  const sharedBridgeRows = rows.filter((r) => isSharedMode && !ownBridgeUserIds.has(r.userId));

  // For each shared-bridge user, fetch their one-click armed state and last audit event
  const userIds = sharedBridgeRows.map((r) => r.userId);
  const armingRows = userIds.length > 0
    ? await db.select({
        userId: userOneClickSettingsTable.userId,
        oneClickArmed: userOneClickSettingsTable.oneClickArmed,
        oneClickArmedAt: userOneClickSettingsTable.oneClickArmedAt,
        oneClickBridgeType: userOneClickSettingsTable.oneClickBridgeType,
      }).from(userOneClickSettingsTable)
    : [];
  const armingByUser = new Map(armingRows.map((r) => [r.userId, r]));

  // Last audit event per user — shows last action, source, result, and block reason
  // so admins have full operational visibility without a separate drill-down.
  const lastAuditRows = userIds.length > 0
    ? await db.select({
        userId: oneClickAuditTable.userId,
        action: oneClickAuditTable.action,
        createdAt: oneClickAuditTable.createdAt,
        metadata: oneClickAuditTable.metadata,
      }).from(oneClickAuditTable)
      .where(
        sql`${oneClickAuditTable.userId} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`
      )
      .orderBy(desc(oneClickAuditTable.createdAt))
    : [];
  // Keep only the most recent row per user
  const lastAuditByUser = new Map<number, { action: string; createdAt: Date | null; metadata: string | null }>();
  for (const row of lastAuditRows) {
    if (!lastAuditByUser.has(row.userId)) {
      lastAuditByUser.set(row.userId, { action: row.action, createdAt: row.createdAt, metadata: row.metadata ?? null });
    }
  }

  return res.json({
    ok: true,
    isSharedMode,
    users: sharedBridgeRows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      masterLiveStatus: r.masterLiveStatus,
      approvedForMasterLive: r.approvedForMasterLive,
      sharedBridgeOneClickPermitted: r.sharedBridgeOneClickPermitted,
      sharedBridgeOneClickPermittedAt: r.sharedBridgeOneClickPermittedAt ?? null,
      sharedBridgeOneClickRevokedAt: r.sharedBridgeOneClickRevokedAt ?? null,
      oneClickArmed: armingByUser.get(r.userId)?.oneClickArmed ?? false,
      oneClickArmedAt: armingByUser.get(r.userId)?.oneClickArmedAt ?? null,
      oneClickBridgeType: armingByUser.get(r.userId)?.oneClickBridgeType ?? null,
      // Operational fields for admin situational awareness.
      // metadata is a JSON string that may include: source, resultStatus,
      // blockReason, bridgeType, grantedBy, revokedBy, reason, etc.
      lastAuditAction: lastAuditByUser.get(r.userId)?.action ?? null,
      lastAuditAt: lastAuditByUser.get(r.userId)?.createdAt ?? null,
      lastAuditMetadata: (() => {
        const raw = lastAuditByUser.get(r.userId)?.metadata;
        if (!raw) return null;
        try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
      })(),
    })),
  });
});

/**
 * POST /api/admin/one-click/users/:userId/grant
 *
 * Grant shared-bridge one-click permission to a user.
 * Requires { reason: string } (min 3 chars).
 * Writes both a master_live_access_audit and one_click_audit row.
 */
router.post("/admin/one-click/users/:userId/grant", async (req: Request, res: Response) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
  }
  const body = (req.body ?? {}) as { reason?: string };
  if (typeof body.reason !== "string" || body.reason.trim().length < 3) {
    return res.status(400).json({ ok: false, error: "REASON_REQUIRED",
      message: "reason must be at least 3 characters." });
  }
  const reason = body.reason.trim();
  const now = new Date();

  // Verify target user exists and has a master live access row
  const [target] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.id, targetId)).limit(1);
  if (!target) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });

  // Hard-gate: target must be a shared-bridge user.
  // Own-bridge users manage their own one-click arming independently.
  const [grantGlobalSettings] = await db.select({ mode: globalTradingSettingsTable.accountRoutingMode })
    .from(globalTradingSettingsTable).limit(1);
  if (grantGlobalSettings?.mode !== "SHARED_MASTER_MT5") {
    return res.status(400).json({ ok: false, error: "NOT_SHARED_BRIDGE_MODE",
      message: "System is not in SHARED_MASTER_MT5 routing mode. Shared-bridge permission is not applicable." });
  }
  const [ownConnGrant] = await db.select({ id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, targetId)).limit(1);
  if (ownConnGrant) {
    return res.status(400).json({ ok: false, error: "USER_HAS_OWN_BRIDGE",
      message: "Target user has their own MT5 bridge. One-click permission for own-bridge users is self-managed, not admin-granted." });
  }

  const [access] = await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, targetId)).limit(1);
  if (!access) {
    return res.status(404).json({ ok: false, error: "MASTER_LIVE_ACCESS_ROW_NOT_FOUND",
      message: "User has no master live access row. Approve them for live trading first." });
  }

  const before = {
    sharedBridgeOneClickPermitted: access.sharedBridgeOneClickPermitted,
    sharedBridgeOneClickPermittedAt: access.sharedBridgeOneClickPermittedAt,
  };

  await db.update(userMasterLiveAccessTable).set({
    sharedBridgeOneClickPermitted: true,
    sharedBridgeOneClickPermittedBy: admin.id,
    sharedBridgeOneClickPermittedAt: now,
    sharedBridgeOneClickRevokedBy: null,
    sharedBridgeOneClickRevokedAt: null,
    updatedAt: now,
  }).where(eq(userMasterLiveAccessTable.userId, targetId));

  await writeMasterLiveAudit({
    adminUserId: admin.id,
    targetUserId: targetId,
    action: "ONE_CLICK_PERMISSION_GRANTED",
    reason,
    metadata: { before, after: { sharedBridgeOneClickPermitted: true, sharedBridgeOneClickPermittedAt: now } },
  });
  await writeOneClickAudit({
    userId: targetId,
    action: "ONE_CLICK_SHARED_BRIDGE_PERMITTED",
    metadata: { grantedBy: admin.id, reason },
  });

  return res.json({
    ok: true,
    userId: targetId,
    sharedBridgeOneClickPermitted: true,
    permittedAt: now.toISOString(),
  });
});

/**
 * POST /api/admin/one-click/users/:userId/revoke
 *
 * Revoke shared-bridge one-click permission and auto-disarm the user.
 * Requires { reason: string } (min 3 chars).
 * Writes both a master_live_access_audit and one_click_audit row.
 */
router.post("/admin/one-click/users/:userId/revoke", async (req: Request, res: Response) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
  }
  const body = (req.body ?? {}) as { reason?: string };
  if (typeof body.reason !== "string" || body.reason.trim().length < 3) {
    return res.status(400).json({ ok: false, error: "REASON_REQUIRED",
      message: "reason must be at least 3 characters." });
  }
  const reason = body.reason.trim();
  const now = new Date();

  const [target] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.id, targetId)).limit(1);
  if (!target) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });

  // Hard-gate: target must be a shared-bridge user.
  const [revokeGlobalSettings] = await db.select({ mode: globalTradingSettingsTable.accountRoutingMode })
    .from(globalTradingSettingsTable).limit(1);
  if (revokeGlobalSettings?.mode !== "SHARED_MASTER_MT5") {
    return res.status(400).json({ ok: false, error: "NOT_SHARED_BRIDGE_MODE",
      message: "System is not in SHARED_MASTER_MT5 routing mode. Shared-bridge permission is not applicable." });
  }
  const [ownConnRevoke] = await db.select({ id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, targetId)).limit(1);
  if (ownConnRevoke) {
    return res.status(400).json({ ok: false, error: "USER_HAS_OWN_BRIDGE",
      message: "Target user has their own MT5 bridge. One-click permission for own-bridge users is self-managed." });
  }

  const [access] = await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, targetId)).limit(1);
  if (!access) {
    return res.status(404).json({ ok: false, error: "MASTER_LIVE_ACCESS_ROW_NOT_FOUND" });
  }

  const [settings] = await db.select({
    oneClickArmed: userOneClickSettingsTable.oneClickArmed,
  }).from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, targetId)).limit(1);
  const wasArmed = settings?.oneClickArmed ?? false;

  await db.update(userMasterLiveAccessTable).set({
    sharedBridgeOneClickPermitted: false,
    sharedBridgeOneClickRevokedBy: admin.id,
    sharedBridgeOneClickRevokedAt: now,
    updatedAt: now,
  }).where(eq(userMasterLiveAccessTable.userId, targetId));

  if (wasArmed) {
    await db.update(userOneClickSettingsTable).set({
      oneClickArmed: false,
      oneClickDisarmedAt: now,
      updatedAt: now,
    }).where(eq(userOneClickSettingsTable.userId, targetId));
    await writeOneClickAudit({
      userId: targetId,
      action: "ONE_CLICK_AUTO_DISARMED",
      metadata: { revokedBy: admin.id, reason },
    });
  }

  // Always write a one-click audit event for the revoke action, regardless of
  // whether the user was armed, so the permission change is fully auditable.
  await writeOneClickAudit({
    userId: targetId,
    action: "ONE_CLICK_PERMISSION_REVOKED",
    metadata: { revokedBy: admin.id, reason, wasArmed },
  });

  await writeMasterLiveAudit({
    adminUserId: admin.id,
    targetUserId: targetId,
    action: "ONE_CLICK_PERMISSION_REVOKED",
    reason,
    metadata: {
      before: { sharedBridgeOneClickPermitted: access.sharedBridgeOneClickPermitted },
      after: { sharedBridgeOneClickPermitted: false, sharedBridgeOneClickRevokedAt: now },
      autoDisarmed: wasArmed,
    },
  });

  return res.json({
    ok: true,
    userId: targetId,
    sharedBridgeOneClickPermitted: false,
    revokedAt: now.toISOString(),
    autoDisarmed: wasArmed,
  });
});

export default router;
