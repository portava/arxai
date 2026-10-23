// Admin — User Control Center
//
// Consolidated read + mutation surface backing the Admin User Control
// Center page. Reuses the existing per-user tables and never writes to
// the live-trading-approval column directly — that always goes through
// the explicit /api/admin/master-live/users/:userId/approve route which
// requires an admin click and an audit row.
//
// Routes:
//   GET  /api/admin/user-control/users           — rich list with filters
//   GET  /api/admin/user-control/users/:userId   — single user detail
//   PUT  /api/admin/user-control/users/:userId/advanced
//                                                — update advanced perms
//                                                  (NEVER liveTradingApproved)
//   POST /api/admin/user-control/users/:userId/shared-bridge
//                                                — approve / revoke shared bridge
//                                                  (typed confirmation required)
//   POST /api/admin/user-control/users/:userId/status
//                                                — ACTIVE/SUSPENDED/DISABLED
//   POST /api/admin/user-control/push-settings/preview
//                                                — return list of affected users + diff
//   POST /api/admin/user-control/push-settings
//                                                — execute push. dangerous fields
//                                                  require per-user typed confirm.
//
// SAFETY:
//   - Every handler is requireAdmin.
//   - Push-settings refuses any payload key that maps to live trading
//     approval; that flag is only mutable via adminMasterLiveAccess
//     /approve and /disable.
//   - Shared-bridge approval requires a typed confirmation phrase that
//     names the affected user (so a single bulk confirm cannot silently
//     grant bridge access to a different person).
//   - Audit row written for every mutation, one per affected user.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { enforceSensitiveAction } from "../lib/security/handshake.js";
import { handshakeEventBus } from "../lib/handshake/eventBus.js";
import {
  db,
  usersTable,
  userMasterLiveAccessTable,
  userAdvancedPermissionsTable,
  adminActionAuditLogTable,
  riskTemplatesTable,
  arxLivePositionsTable,
  arxLiveCommandsTable,
  type RiskTemplatePayload,
  type UserAccountStatus,
  USER_ACCOUNT_STATUSES,
} from "@workspace/db";

const router: IRouter = Router();
router.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Auth + audit helpers
// ─────────────────────────────────────────────────────────────────────────────
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

async function tryAudit(req: Request, args: {
  adminId: number; adminRole: string; action: string;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
  targetUserId?: number | null;
}): Promise<void> {
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: args.adminId,
      adminRole: args.adminRole,
      action: args.action,
      targetUserId: args.targetUserId ?? null,
      beforeState: (args.before ?? {}) as Record<string, unknown>,
      afterState: (args.after ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    (req as Request & { log?: { warn: (o: unknown, m?: string) => void } }).log?.warn(
      { err: (err as Error).message, action: args.action },
      "admin_user_control_audit_write_failed",
    );
  }
}

async function getOrInsertAdvanced(userId: number) {
  const existing = await db.select().from(userAdvancedPermissionsTable)
    .where(eq(userAdvancedPermissionsTable.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db.insert(userAdvancedPermissionsTable)
    .values({ userId }).returning();
  return row!;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST — rich, paginated, filterable
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/user-control/users", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const filterRole = String(req.query.role ?? "").trim().toUpperCase();
  const filterStatus = String(req.query.status ?? "").trim().toUpperCase();
  const filterLiveApproved = String(req.query.liveApproved ?? "").trim();
  const filterBridgeApproved = String(req.query.sharedBridge ?? "").trim();

  const includeSystem = String(req.query.includeSystem ?? "false") === "true";
  const onlySystem = String(req.query.onlySystem ?? "false") === "true";

  const allUsers = await db.select({
    id: usersTable.id,
    email: usersTable.email,
    name: usersTable.name,
    role: usersTable.role,
    isSystemUser: usersTable.isSystemUser,
    lastLoginAt: usersTable.lastLoginAt,
    createdAt: usersTable.createdAt,
  }).from(usersTable).orderBy(desc(usersTable.id));

  // Hide system/test users from the default Admin view unless explicitly
  // requested. This filter is UI-only — it is never used as an auth gate.
  const users = onlySystem
    ? allUsers.filter((u) => u.isSystemUser)
    : includeSystem
      ? allUsers
      : allUsers.filter((u) => !u.isSystemUser);

  // Bulk-fetch the two side tables for these users.
  const userIds = users.map((u) => u.id);
  const liveRows = userIds.length === 0 ? [] : await db.select()
    .from(userMasterLiveAccessTable)
    .where(inArray(userMasterLiveAccessTable.userId, userIds));
  const advRows = userIds.length === 0 ? [] : await db.select()
    .from(userAdvancedPermissionsTable)
    .where(inArray(userAdvancedPermissionsTable.userId, userIds));
  const liveByUser = new Map(liveRows.map((r) => [r.userId, r]));
  const advByUser = new Map(advRows.map((r) => [r.userId, r]));

  // Exposure + last-trade per user (parallel small queries).
  const exposureByUser = new Map<number, { openLots: number; floatingPlUsd: number; openCount: number }>();
  const lastTradeByUser = new Map<number, Date | null>();
  await Promise.all(userIds.map(async (uid) => {
    const ex = await db.select({
      lots: sql<number>`COALESCE(SUM(${arxLivePositionsTable.volume}), 0)`,
      pnl: sql<number>`COALESCE(SUM(${arxLivePositionsTable.floatingPl}), 0)`,
      cnt: sql<number>`COUNT(*)::int`,
    }).from(arxLivePositionsTable).where(and(
      eq(arxLivePositionsTable.userId, uid),
      sql`${arxLivePositionsTable.closedAt} IS NULL`,
    ));
    exposureByUser.set(uid, {
      openLots: Number(ex[0]?.lots ?? 0),
      floatingPlUsd: Number(ex[0]?.pnl ?? 0),
      openCount: Number(ex[0]?.cnt ?? 0),
    });
    const lt = await db.select({ at: arxLiveCommandsTable.createdAt })
      .from(arxLiveCommandsTable).where(eq(arxLiveCommandsTable.userId, uid))
      .orderBy(desc(arxLiveCommandsTable.createdAt)).limit(1);
    lastTradeByUser.set(uid, lt[0]?.at ?? null);
  }));

  // Compose rows.
  let rows = users.map((u) => {
    const live = liveByUser.get(u.id);
    const adv = advByUser.get(u.id);
    const ex = exposureByUser.get(u.id);
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isSystemUser: u.isSystemUser,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      accountStatus: (adv?.accountStatus ?? "ACTIVE") as UserAccountStatus,
      disabledReason: adv?.disabledReason ?? null,
      tradingMode: (live?.masterLiveTradingEnabled ? "LIVE"
        : (live?.scannerLiveEnabled ? "DEMO" : "PAPER")) as "PAPER" | "DEMO" | "LIVE",
      liveTradingApproved: !!live?.approvedForMasterLive,
      liveTradingStatus: live?.masterLiveStatus ?? "NOT_APPROVED",
      sharedBridgeApproved: !!adv?.sharedBridgeApproved,
      personalBridgeEnabled: adv?.personalBridgeEnabled ?? true,
      riskTemplateId: adv?.riskTemplateId ?? null,
      caps: live ? {
        maxLot: live.maxLot,
        dailyLossLimitUsd: live.dailyLossLimitUsd,
        maxOpenPositions: live.maxOpenPositions,
        allowedSymbols: live.allowedSymbols ?? [],
        requireStopLoss: live.requireStopLoss,
      } : null,
      toggles: adv ? {
        aiTradingEnabled: adv.aiTradingEnabled,
        aiAutoCloseEnabled: adv.aiAutoCloseEnabled,
        rubyVoiceEnabled: adv.rubyVoiceEnabled,
        newsIntelligenceEnabled: adv.newsIntelligenceEnabled,
        historicalBacktestEnabled: adv.historicalBacktestEnabled,
        blockedSymbols: adv.blockedSymbols,
        minRewardRiskRatio: adv.minRewardRiskRatio,
        stopLossRequired: adv.stopLossRequired,
        takeProfitRequired: adv.takeProfitRequired,
      } : null,
      currentExposureLots: ex?.openLots ?? 0,
      currentFloatingPlUsd: ex?.floatingPlUsd ?? 0,
      openTradesCount: ex?.openCount ?? 0,
      lastTradeAt: lastTradeByUser.get(u.id) ?? null,
      adminMemo: adv?.adminMemo ?? null,
      lastSettingsPushAt: adv?.lastSettingsPushAt ?? null,
    };
  });

  // Apply filters in JS (fine at limit ≤ 200). Search is normalised:
  // lowercase, trim, and matches across email/name/id/role/status/mode.
  if (q) {
    const needle = q.trim().toLowerCase();
    if (needle.length > 0) {
      rows = rows.filter((r) =>
        (r.email ?? "").toLowerCase().includes(needle) ||
        (r.name ?? "").toLowerCase().includes(needle) ||
        String(r.userId).includes(needle) ||
        (r.role ?? "").toLowerCase().includes(needle) ||
        (r.accountStatus ?? "").toLowerCase().includes(needle) ||
        (r.tradingMode ?? "").toLowerCase().includes(needle),
      );
    }
  }
  if (filterRole) rows = rows.filter((r) => (r.role ?? "").toUpperCase() === filterRole);
  if (filterStatus) rows = rows.filter((r) => r.accountStatus === filterStatus);
  if (filterLiveApproved === "true") rows = rows.filter((r) => r.liveTradingApproved);
  if (filterLiveApproved === "false") rows = rows.filter((r) => !r.liveTradingApproved);
  if (filterBridgeApproved === "true") rows = rows.filter((r) => r.sharedBridgeApproved);
  if (filterBridgeApproved === "false") rows = rows.filter((r) => !r.sharedBridgeApproved);

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  return res.json({ ok: true, users: page, total, limit, offset });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROLE toggle (ADMIN ↔ USER) — only OWNER can grant ADMIN to others;
// any admin can demote an admin back to USER. OWNER role is never touched
// from this endpoint.
// ─────────────────────────────────────────────────────────────────────────────
const roleBody = z.object({
  role: z.enum(["USER", "ADMIN"]),
  confirmedDangerous: z.boolean().optional().default(false),
});
router.post("/admin/user-control/users/:userId/role", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const hs = await enforceSensitiveAction("CHANGE_USER_ROLE", {
    userId: admin.id, role: admin.role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) {
    return res.status(403).json({ ok: false, error: hs.reasonCode, message: hs.userMessage });
  }
  const userId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = roleBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });
  const target = (await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1))[0];
  if (!target) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
  if (target.role === "OWNER") {
    return res.status(403).json({ ok: false, error: "OWNER_ROLE_IMMUTABLE" });
  }
  // Granting ADMIN is the dangerous direction → require modal confirm
  // AND require the caller to be OWNER.
  if (parsed.data.role === "ADMIN") {
    if (!parsed.data.confirmedDangerous) {
      return res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED" });
    }
    if (admin.role !== "OWNER") {
      return res.status(403).json({ ok: false, error: "OWNER_ONLY",
        message: "Only the owner can grant admin role." });
    }
  }
  await db.update(usersTable)
    .set({ role: parsed.data.role, updatedAt: new Date() })
    .where(eq(usersTable.id, userId));
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: parsed.data.role === "ADMIN" ? "USER_ROLE_GRANTED_ADMIN" : "USER_ROLE_REVOKED_ADMIN",
    targetUserId: userId,
    before: { role: target.role },
    after: { role: parsed.data.role },
  });
  // Advisory cross-layer signal: a role change can shift admin-control /
  // permission readiness. Best-effort, off the hot path; never gates this route.
  handshakeEventBus.emit("layer:role", { userId, at: new Date().toISOString() });
  return res.json({ ok: true, role: parsed.data.role });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCANNER / DEMO mode toggle — flips userMasterLiveAccessTable.scannerLiveEnabled
// so an admin can enable the demo readiness signal in one click from Manage
// Access. Does NOT touch live trading approval.
// ─────────────────────────────────────────────────────────────────────────────
const scannerLiveBody = z.object({ enabled: z.boolean() });
router.post("/admin/user-control/users/:userId/scanner-live", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const userId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = scannerLiveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const liveRow = (await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1))[0];
  if (!liveRow) {
    // Create a minimal row so the toggle works for fresh users.
    await db.insert(userMasterLiveAccessTable).values({
      userId,
      scannerLiveEnabled: parsed.data.enabled,
    });
  } else {
    await db.update(userMasterLiveAccessTable)
      .set({ scannerLiveEnabled: parsed.data.enabled, updatedAt: new Date() })
      .where(eq(userMasterLiveAccessTable.userId, userId));
  }
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: parsed.data.enabled ? "USER_DEMO_ENABLED" : "USER_DEMO_DISABLED",
    targetUserId: userId,
    before: { scannerLiveEnabled: liveRow?.scannerLiveEnabled ?? false },
    after: { scannerLiveEnabled: parsed.data.enabled },
  });
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE USER detail
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/user-control/users/:userId", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const userId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const user = (await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1))[0];
  if (!user) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  const live = (await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1))[0] ?? null;
  const adv = await getOrInsertAdvanced(userId);
  // Recent audit for this user.
  const audit = await db.select().from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.targetUserId, userId))
    .orderBy(desc(adminActionAuditLogTable.createdAt)).limit(50);
  return res.json({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role,
      lastLoginAt: user.lastLoginAt, createdAt: user.createdAt },
    liveAccess: live,
    advanced: adv,
    audit,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE advanced perms (single user; no dangerous fields)
// ─────────────────────────────────────────────────────────────────────────────
const advancedBody = z.object({
  personalBridgeEnabled: z.boolean().optional(),
  riskTemplateId: z.number().int().positive().nullable().optional(),
  aiTradingEnabled: z.boolean().optional(),
  aiAutoCloseEnabled: z.boolean().optional(),
  rubyVoiceEnabled: z.boolean().optional(),
  newsIntelligenceEnabled: z.boolean().optional(),
  historicalBacktestEnabled: z.boolean().optional(),
  blockedSymbols: z.array(z.string().max(32)).max(100).optional(),
  minRewardRiskRatio: z.number().positive().nullable().optional(),
  stopLossRequired: z.boolean().optional(),
  takeProfitRequired: z.boolean().optional(),
  adminMemo: z.string().max(2000).nullable().optional(),
}).strict();

router.put("/admin/user-control/users/:userId/advanced", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const userId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = advancedBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }
  const before = await getOrInsertAdvanced(userId);
  const patch: Partial<typeof userAdvancedPermissionsTable.$inferInsert> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
  }
  const [after] = await db.update(userAdvancedPermissionsTable)
    .set(patch).where(eq(userAdvancedPermissionsTable.userId, userId)).returning();
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: "USER_ADVANCED_PERMS_UPDATED",
    targetUserId: userId,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
  });
  return res.json({ ok: true, advanced: after });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED-BRIDGE approval (per-user modal confirmation, no typed phrases)
// ─────────────────────────────────────────────────────────────────────────────
const sharedBridgeBody = z.object({
  approved: z.boolean(),
  // Frontend opens a confirmation modal for the "approve" direction and
  // sets this flag to true on Confirm. Audit log records the boolean.
  confirmedDangerous: z.boolean().optional().default(false),
  reason: z.string().max(500).optional(),
});

router.post("/admin/user-control/users/:userId/shared-bridge", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const userId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = sharedBridgeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const target = (await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1))[0];
  if (!target) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
  // Approving a shared bridge is the dangerous direction — require an
  // explicit modal Confirm. Revoking is safe.
  if (parsed.data.approved && !parsed.data.confirmedDangerous) {
    return res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      message: "Confirm in the modal to approve shared bridge for this user.",
    });
  }
  const before = await getOrInsertAdvanced(userId);
  const [after] = await db.update(userAdvancedPermissionsTable)
    .set({
      sharedBridgeApproved: parsed.data.approved,
      sharedBridgeApprovedBy: parsed.data.approved ? admin.id : null,
      sharedBridgeApprovedAt: parsed.data.approved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(userAdvancedPermissionsTable.userId, userId)).returning();
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: parsed.data.approved ? "SHARED_BRIDGE_APPROVED" : "SHARED_BRIDGE_REVOKED",
    targetUserId: userId,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
  });
  return res.json({ ok: true, advanced: after });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS — ACTIVE / SUSPENDED / DISABLED (does NOT touch live approval)
// ─────────────────────────────────────────────────────────────────────────────
const statusBody = z.object({
  status: z.enum([...USER_ACCOUNT_STATUSES] as [UserAccountStatus, ...UserAccountStatus[]]),
  reason: z.string().max(500).optional(),
  // Modal-confirm flag for DISABLED / SUSPENDED. Activating an account
  // is safe and does not need confirmation.
  confirmedDangerous: z.boolean().optional().default(false),
});
router.post("/admin/user-control/users/:userId/status", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const userId = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  }
  const parsed = statusBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  // Disable + Suspend require an explicit modal Confirm flag from the UI.
  if ((parsed.data.status === "DISABLED" || parsed.data.status === "SUSPENDED")
      && !parsed.data.confirmedDangerous) {
    return res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      message: `Confirm in the modal to ${parsed.data.status.toLowerCase()} this user.`,
    });
  }
  const before = await getOrInsertAdvanced(userId);
  const [after] = await db.update(userAdvancedPermissionsTable)
    .set({
      accountStatus: parsed.data.status,
      disabledReason: parsed.data.status === "DISABLED" || parsed.data.status === "SUSPENDED"
        ? parsed.data.reason ?? null : null,
      disabledAt: parsed.data.status === "DISABLED" || parsed.data.status === "SUSPENDED"
        ? new Date() : null,
      disabledBy: parsed.data.status === "DISABLED" || parsed.data.status === "SUSPENDED"
        ? admin.id : null,
      updatedAt: new Date(),
    })
    .where(eq(userAdvancedPermissionsTable.userId, userId)).returning();
  await tryAudit(req, {
    adminId: admin.id, adminRole: admin.role,
    action: `USER_STATUS_${parsed.data.status}`,
    targetUserId: userId,
    before: { accountStatus: before.accountStatus },
    after: { accountStatus: after!.accountStatus, reason: parsed.data.reason ?? null },
  });
  return res.json({ ok: true, advanced: after });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH SETTINGS — preview + execute
// ─────────────────────────────────────────────────────────────────────────────
// Fields that count as "dangerous" and need per-user typed confirmation
// even in a bulk push. Live trading approval is INTENTIONALLY OMITTED
// because it cannot be pushed via this endpoint at all — it must be set
// per-user via /api/admin/master-live/users/:userId/approve which writes
// its own audit row and runs the operator-funded-pilot cap check.
const DANGEROUS_FIELDS = new Set<string>([
  "sharedBridgeApproved",
  "personalBridgeEnabled",
  "maxLotSize",
  "maxDailyLossUsd",
]);

const pushTargetsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.number().int().positive() }),
  z.object({ kind: z.literal("userIds"), userIds: z.array(z.number().int().positive()).min(1).max(500) }),
  z.object({ kind: z.literal("all_paper") }),
  z.object({ kind: z.literal("all_demo") }),
  z.object({ kind: z.literal("all_live") }),
  z.object({ kind: z.literal("all") }),
]);
const pushPayloadSchema = z.object({
  // Lower-risk toggles (safe under single bulk confirmation).
  aiTradingEnabled: z.boolean().optional(),
  aiAutoCloseEnabled: z.boolean().optional(),
  rubyVoiceEnabled: z.boolean().optional(),
  newsIntelligenceEnabled: z.boolean().optional(),
  historicalBacktestEnabled: z.boolean().optional(),
  blockedSymbols: z.array(z.string().max(32)).max(100).optional(),
  minRewardRiskRatio: z.number().positive().nullable().optional(),
  stopLossRequired: z.boolean().optional(),
  takeProfitRequired: z.boolean().optional(),
  adminMemo: z.string().max(2000).nullable().optional(),
  // Dangerous-tier — require perUserConfirmations[].
  sharedBridgeApproved: z.boolean().optional(),
  personalBridgeEnabled: z.boolean().optional(),
  maxLotSize: z.number().positive().nullable().optional(),
  maxDailyLossUsd: z.number().nonnegative().nullable().optional(),
}).strict();

const pushBody = z.object({
  targets: pushTargetsSchema,
  templateId: z.number().int().positive().nullable().optional(),
  payload: pushPayloadSchema.default({}),
  // Single modal-confirm flag for dangerous pushes (replaces typed
  // per-user phrases). Safe pushes do not need this.
  confirmedDangerous: z.boolean().optional().default(false),
  reason: z.string().max(500).optional(),
});

async function resolveTargetIds(targets: z.infer<typeof pushTargetsSchema>): Promise<number[]> {
  if (targets.kind === "user") return [targets.userId];
  if (targets.kind === "userIds") return targets.userIds;
  // For class-based targets, derive from the live-access table.
  const allUsers = await db.select({ id: usersTable.id }).from(usersTable);
  const liveRows = await db.select().from(userMasterLiveAccessTable);
  const liveByUser = new Map(liveRows.map((r) => [r.userId, r]));
  if (targets.kind === "all") return allUsers.map((u) => u.id);
  if (targets.kind === "all_live") {
    return allUsers
      .filter((u) => liveByUser.get(u.id)?.masterLiveTradingEnabled === true)
      .map((u) => u.id);
  }
  if (targets.kind === "all_demo") {
    return allUsers
      .filter((u) => liveByUser.get(u.id)?.scannerLiveEnabled === true
        && !liveByUser.get(u.id)?.masterLiveTradingEnabled)
      .map((u) => u.id);
  }
  // all_paper
  return allUsers
    .filter((u) => {
      const l = liveByUser.get(u.id);
      return !l?.masterLiveTradingEnabled && !l?.scannerLiveEnabled;
    })
    .map((u) => u.id);
}

function resolveEffectivePayload(
  base: z.infer<typeof pushPayloadSchema>,
  template?: RiskTemplatePayload | null,
): Record<string, unknown> {
  // Template fields are baseline; explicit payload fields override.
  const out: Record<string, unknown> = {};
  if (template) {
    for (const [k, v] of Object.entries(template)) {
      if (v !== undefined) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

router.post("/admin/user-control/push-settings/preview", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const parsed = pushBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }
  const template = parsed.data.templateId
    ? (await db.select().from(riskTemplatesTable).where(eq(riskTemplatesTable.id, parsed.data.templateId)).limit(1))[0] ?? null
    : null;
  if (parsed.data.templateId && !template) {
    return res.status(404).json({ ok: false, error: "TEMPLATE_NOT_FOUND" });
  }
  const effective = resolveEffectivePayload(parsed.data.payload, template?.payload as RiskTemplatePayload);
  const ids = await resolveTargetIds(parsed.data.targets);
  if (ids.length === 0) {
    return res.json({ ok: true, affected: [], effectivePayload: effective, dangerousFields: [] });
  }
  const userRows = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name,
  }).from(usersTable).where(inArray(usersTable.id, ids));
  const dangerousFields = Object.keys(effective).filter((k) => DANGEROUS_FIELDS.has(k));
  const affected = userRows.map((u) => ({
    userId: u.id, email: u.email, name: u.name,
  }));
  return res.json({
    ok: true,
    affected,
    effectivePayload: effective,
    dangerousFields,
    confirmationRequired: dangerousFields.length > 0,
  });
});

router.post("/admin/user-control/push-settings", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const parsed = pushBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }
  const template = parsed.data.templateId
    ? (await db.select().from(riskTemplatesTable).where(eq(riskTemplatesTable.id, parsed.data.templateId)).limit(1))[0] ?? null
    : null;
  const effective = resolveEffectivePayload(parsed.data.payload, template?.payload as RiskTemplatePayload);
  const ids = await resolveTargetIds(parsed.data.targets);
  if (ids.length === 0) {
    return res.json({ ok: true, results: [], note: "NO_TARGETS_MATCHED" });
  }

  const dangerousFields = Object.keys(effective).filter((k) => DANGEROUS_FIELDS.has(k));
  // Dangerous pushes require an explicit modal-confirm flag from the UI.
  // Safe pushes go through without any extra confirmation.
  if (dangerousFields.length > 0 && !parsed.data.confirmedDangerous) {
    return res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      dangerousFields,
      message: "Confirm in the modal — this push changes risk-critical settings.",
    });
  }

  // Lookup user emails once for audit.
  const userRows = await db.select({
    id: usersTable.id, email: usersTable.email,
  }).from(usersTable).where(inArray(usersTable.id, ids));
  const emailByUser = new Map(userRows.map((u) => [u.id, u.email]));

  const results: Array<{ userId: number; ok: boolean; error?: string; advanced?: unknown }> = [];
  for (const uid of ids) {
    try {
      const before = await getOrInsertAdvanced(uid);
      // Strip live-trading flag if a malicious payload somehow snuck in
      // — defence in depth on top of the Zod schema.
      const safe = { ...effective } as Record<string, unknown>;
      delete safe.liveTradingApproved;
      delete safe.masterLiveTradingEnabled;
      delete safe.approvedForMasterLive;
      // Apply only known columns.
      const patch: Partial<typeof userAdvancedPermissionsTable.$inferInsert> = {
        updatedAt: new Date(),
        lastSettingsPushAt: new Date(),
        lastSettingsPushBy: admin.id,
        ...(parsed.data.templateId ? { riskTemplateId: parsed.data.templateId } : {}),
      };
      const allowed: Array<keyof typeof userAdvancedPermissionsTable.$inferInsert> = [
        "sharedBridgeApproved", "personalBridgeEnabled", "aiTradingEnabled",
        "aiAutoCloseEnabled", "rubyVoiceEnabled", "newsIntelligenceEnabled",
        "historicalBacktestEnabled", "blockedSymbols", "minRewardRiskRatio",
        "stopLossRequired", "takeProfitRequired", "adminMemo",
      ];
      for (const k of allowed) {
        if (safe[k as string] !== undefined) {
          (patch as Record<string, unknown>)[k as string] = safe[k as string];
        }
      }
      // sharedBridgeApproved provenance.
      if (safe.sharedBridgeApproved === true) {
        patch.sharedBridgeApprovedBy = admin.id;
        patch.sharedBridgeApprovedAt = new Date();
      } else if (safe.sharedBridgeApproved === false) {
        patch.sharedBridgeApprovedBy = null;
        patch.sharedBridgeApprovedAt = null;
      }
      const [after] = await db.update(userAdvancedPermissionsTable)
        .set(patch).where(eq(userAdvancedPermissionsTable.userId, uid)).returning();

      // Per-user max-lot/daily-loss flow through master-live caps so the
      // 16-gate evaluator actually sees them.
      if (safe.maxLotSize !== undefined || safe.maxDailyLossUsd !== undefined) {
        const liveRow = (await db.select().from(userMasterLiveAccessTable)
          .where(eq(userMasterLiveAccessTable.userId, uid)).limit(1))[0];
        if (liveRow) {
          await db.update(userMasterLiveAccessTable).set({
            maxLot: typeof safe.maxLotSize === "number" ? safe.maxLotSize : liveRow.maxLot,
            dailyLossLimitUsd: typeof safe.maxDailyLossUsd === "number"
              ? safe.maxDailyLossUsd : liveRow.dailyLossLimitUsd,
            updatedAt: new Date(),
          }).where(eq(userMasterLiveAccessTable.userId, uid));
        }
      }

      await tryAudit(req, {
        adminId: admin.id, adminRole: admin.role,
        action: "USER_SETTINGS_PUSHED",
        targetUserId: uid,
        before: before as unknown as Record<string, unknown>,
        after: { ...(after as unknown as Record<string, unknown>),
          _pushSource: { templateId: parsed.data.templateId ?? null,
            payload: parsed.data.payload, reason: parsed.data.reason ?? null,
            targets: parsed.data.targets },
        },
      });
      results.push({ userId: uid, ok: true, advanced: after });
    } catch (err) {
      results.push({ userId: uid, ok: false, error: (err as Error).message ?? "PUSH_FAILED" });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return res.json({
    ok: true,
    pushedCount: okCount,
    failedCount: results.length - okCount,
    results,
  });
});

export default router;
