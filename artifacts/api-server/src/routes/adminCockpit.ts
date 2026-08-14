// ── Admin Cockpit (Task #752) — admin/owner-only control room ───────────────
//
// SAFETY (inviolable):
// - Every endpoint here is admin/owner-only. Missing session ⇒ 401; a
//   non-operator (resolved EFFECTIVE role) ⇒ 403. The gate uses
//   operatorRoleFromSession(req.authUser?.role) — the SAME effective-role seam
//   the rest of the operator surfaces use (preview-as-user is NOT an operator).
// - This module is READ aggregation + operator control. It introduces NO new
//   execution path and relaxes NO gate. Every WRITE delegates to the EXISTING
//   audited admin handler (master-live status core, live arming, emergency
//   close, investor pause/resume) and ADDITIONALLY writes one
//   admin_cockpit_audit_log row recording that the action came from the cockpit.
//   The canonical audit row is still written by the delegated handler.
// - Broker-sensitive values (account login/number, balance, equity) are masked
//   to null unless the caller is OWNER. `masked:true` is set on any row that
//   withheld values.
// - Mutations require a reason (>= 3 chars), enforced by Zod before any write.
// - Pattern Sync here is admin-only and ADVISORY. It never gates or sizes a
//   trade; it is a self-contained structural comparator over real candles
//   (honest-empty on insufficient history).

import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  mt5ConnectionTable,
  userMasterLiveAccessTable,
  investorProfilesTable,
  arxLivePositionsTable,
  arxLiveArmingTable,
  strategyPoolsTable,
  strategyPoolNavTable,
  investorPoolHoldingsTable,
  adminCockpitAuditLogTable,
  adminCockpitAlertsTable,
  adminCockpitNotesTable,
  adminActionAuditLogTable,
  masterLiveAccessAuditTable,
} from "@workspace/db";
import { market } from "@workspace/domain";

import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";
import {
  approveTraderForMasterLiveCore,
  changeMasterLiveStatusCore,
  type MasterLiveAdminActor,
} from "./adminMasterLiveAccess.js";
import {
  adminForceArmLiveForUser,
  disarmLiveForUser,
} from "../lib/live/liveArming.js";
import { runEmergencyClose } from "../lib/live/emergencyClose.js";
import { buildApprovedTraderLiveState } from "../lib/live/approvedTraderLiveState.js";
import { getGlobalSettings } from "../lib/adminTrading/safetyEnvelope.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "../lib/live/phaseBConfig.js";
import { getProviderHealthSnapshot } from "../lib/data/providerHealth.js";
import { getPoolNav } from "../lib/fundbook/navEngine.js";
import { routeCandles } from "../lib/data/marketDataRouter.js";
import {
  runPatternSyncEngine,
  patternMatchScore,
  PATTERN_SYNC_MIN_CANDLES,
  type PatternSyncCandle,
  type PatternSyncEngineResult,
} from "../lib/patternSync/patternSyncEngine.js";
import {
  comparePatternSync,
  type PatternSyncSymbolInput,
} from "../lib/patternSync/patternSyncComparator.js";

const router = Router();

// A bridge heartbeat newer than this is "connected/fresh" for cockpit display.
const BRIDGE_FRESH_MS = 60_000;

// ─── Auth gate ──────────────────────────────────────────────────────────────

interface CockpitOperator {
  id: number;
  role: "ADMIN" | "OWNER";
}

function readAuthUser(req: Request): { id?: number; role?: string } | undefined {
  return (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
}

/**
 * Resolve the effective operator (ADMIN | OWNER) or respond 401/403. Returns
 * null after writing the response when the caller is not an operator. Uses the
 * EFFECTIVE role seam — a preview-as-user session is NOT an operator.
 */
function requireOperator(req: Request, res: Response): CockpitOperator | null {
  const au = readAuthUser(req);
  if (!au?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = operatorRoleFromSession(au.role);
  if (!role) {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return { id: au.id, role };
}

// ─── Cockpit audit mirror ────────────────────────────────────────────────────

async function writeCockpitAudit(args: {
  operator: CockpitOperator;
  actionType: string;
  targetType: string;
  targetUserId?: number | null;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
  delegatedAuditRef?: string | null;
  log?: { warn: (obj: unknown, msg?: string) => void };
}): Promise<void> {
  try {
    await db.insert(adminCockpitAuditLogTable).values({
      adminUserId: args.operator.id,
      adminRole: args.operator.role,
      actionType: args.actionType,
      targetType: args.targetType,
      targetUserId: args.targetUserId ?? null,
      beforeState: (args.beforeState ?? {}) as Record<string, unknown>,
      afterState: (args.afterState ?? {}) as Record<string, unknown>,
      delegatedAuditRef: args.delegatedAuditRef ?? null,
      reason: args.reason ?? null,
      ipAddress: args.ip ?? null,
      metadata: (args.metadata ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    // Best-effort mirror — never blocks the delegated (already-audited) action.
    args.log?.warn({ err: String(err), actionType: args.actionType }, "cockpit audit mirror insert failed");
  }
}

// ─── Body schemas ─────────────────────────────────────────────────────────────

const reasonBody = z.object({ reason: z.string().min(3).max(500) });
const fullActivationBody = z.object({
  reason: z.string().min(3).max(500),
  enabled: z.boolean(),
});
const manualNoteBody = z.object({
  note: z.string().min(1).max(2000),
  targetType: z.enum(["trader", "investor", "platform"]).optional(),
  targetUserId: z.number().int().positive().nullable().optional(),
  isPinned: z.boolean().optional(),
});

// ─── Shared aggregation helpers ──────────────────────────────────────────────

function parseUserIdParam(req: Request): number | null {
  const id = parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function heartbeatAgeSeconds(lastHeartbeat: Date | null): number | null {
  if (!lastHeartbeat) return null;
  return Math.max(0, Math.round((Date.now() - new Date(lastHeartbeat).getTime()) / 1000));
}

interface TraderRow {
  userId: number;
  email: string;
  displayName: string | null;
  role: string;
  liveStatus: string;
  armed: boolean;
  approved: boolean;
  openPositions: number;
  floatingPl: number;
  assignedAllocation: number | null;
  reservedRisk: number | null;
  lastActivityAt: string | null;
}

/**
 * Build one cockpit trader row per user, set-based. Every user is a potential
 * trader; investors are surfaced separately. Allocation/reserved-risk are honest
 * nulls (not cheaply derivable here). Open-position counts and floating P/L come
 * from the open arx_live_positions rows grouped by user.
 */
async function computeTraderRows(): Promise<TraderRow[]> {
  const [users, access, arming, openAgg, profiles] = await Promise.all([
    db.select({
      id: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
      lastLoginAt: usersTable.lastLoginAt,
    }).from(usersTable),
    db.select({
      userId: userMasterLiveAccessTable.userId,
      status: userMasterLiveAccessTable.masterLiveStatus,
      approved: userMasterLiveAccessTable.approvedForMasterLive,
    }).from(userMasterLiveAccessTable),
    db.select({
      userId: arxLiveArmingTable.userId,
      isArmed: arxLiveArmingTable.isArmed,
    }).from(arxLiveArmingTable),
    db.select({
      userId: arxLivePositionsTable.userId,
      cnt: sql<number>`cast(count(*) as int)`,
      floating: sql<number>`coalesce(sum(${arxLivePositionsTable.floatingPl}), 0)`,
    }).from(arxLivePositionsTable)
      .where(isNull(arxLivePositionsTable.closedAt))
      .groupBy(arxLivePositionsTable.userId),
    db.select({
      userId: investorProfilesTable.userId,
      displayName: investorProfilesTable.displayName,
    }).from(investorProfilesTable),
  ]);

  const accessMap = new Map(access.map((a) => [a.userId, a]));
  const armingMap = new Map(arming.map((a) => [a.userId, a.isArmed]));
  const openMap = new Map(openAgg.map((o) => [o.userId, o]));
  const nameMap = new Map(profiles.map((p) => [p.userId, p.displayName]));

  return users.map((u) => {
    const a = accessMap.get(u.id);
    const open = openMap.get(u.id);
    return {
      userId: u.id,
      email: u.email,
      displayName: nameMap.get(u.id) ?? null,
      role: u.role ?? "USER",
      liveStatus: a?.status ?? "NOT_APPROVED",
      armed: armingMap.get(u.id) ?? false,
      approved: a?.approved ?? false,
      openPositions: open?.cnt ?? 0,
      floatingPl: Number(open?.floating ?? 0),
      assignedAllocation: null,
      reservedRisk: null,
      lastActivityAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    };
  });
}

interface CockpitAuditEntry {
  id: string;
  source: string;
  actorRole: string | null;
  actorId: number | null;
  action: string;
  targetType: string | null;
  targetUserId: number | null;
  reason: string | null;
  detail: string | null;
  createdAt: string;
}

/**
 * Read the unified audit timeline from the three canonical sources (cockpit
 * mirror, admin action audit, master-live access audit), optionally scoped to a
 * single user, newest-first, capped to `limit`.
 */
async function loadAuditEntries(limit: number, userId?: number): Promise<CockpitAuditEntry[]> {
  const cap = Math.min(Math.max(limit, 1), 500);

  const cockpitQ = db.select().from(adminCockpitAuditLogTable)
    .where(userId ? eq(adminCockpitAuditLogTable.targetUserId, userId) : undefined)
    .orderBy(desc(adminCockpitAuditLogTable.createdAt)).limit(cap);
  const adminQ = db.select().from(adminActionAuditLogTable)
    .where(userId ? eq(adminActionAuditLogTable.targetUserId, userId) : undefined)
    .orderBy(desc(adminActionAuditLogTable.createdAt)).limit(cap);
  const masterQ = db.select().from(masterLiveAccessAuditTable)
    .where(userId ? eq(masterLiveAccessAuditTable.targetUserId, userId) : undefined)
    .orderBy(desc(masterLiveAccessAuditTable.createdAt)).limit(cap);

  const [cockpit, admin, master] = await Promise.all([cockpitQ, adminQ, masterQ]);

  const entries: CockpitAuditEntry[] = [];
  for (const r of cockpit) {
    entries.push({
      id: `cockpit:${r.id}`,
      source: "cockpit",
      actorRole: r.adminRole ?? null,
      actorId: r.adminUserId ?? null,
      action: r.actionType,
      targetType: r.targetType ?? null,
      targetUserId: r.targetUserId ?? null,
      reason: r.reason ?? null,
      detail: r.delegatedAuditRef ? `delegated:${r.delegatedAuditRef}` : null,
      createdAt: new Date(r.createdAt).toISOString(),
    });
  }
  for (const r of admin) {
    entries.push({
      id: `admin:${r.id}`,
      source: "admin",
      actorRole: r.adminRole ?? null,
      actorId: r.adminId ?? null,
      action: r.action,
      targetType: null,
      targetUserId: r.targetUserId ?? null,
      reason: r.reason ?? null,
      detail: null,
      createdAt: new Date(r.createdAt).toISOString(),
    });
  }
  for (const r of master) {
    entries.push({
      id: `master_live:${r.id}`,
      source: "master_live",
      actorRole: null,
      actorId: r.adminUserId ?? null,
      action: r.action,
      targetType: "trader",
      targetUserId: r.targetUserId ?? null,
      reason: r.reason ?? null,
      detail: null,
      createdAt: new Date(r.createdAt).toISOString(),
    });
  }

  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return entries.slice(0, cap);
}

interface CockpitNoteDTO {
  id: number;
  targetType: string | null;
  targetUserId: number | null;
  authorId: number | null;
  authorRole: string | null;
  note: string;
  isPinned: boolean;
  createdAt: string;
}

async function loadNotes(targetType: string, targetUserId?: number): Promise<CockpitNoteDTO[]> {
  const where = targetUserId
    ? and(eq(adminCockpitNotesTable.targetType, targetType), eq(adminCockpitNotesTable.targetUserId, targetUserId))
    : eq(adminCockpitNotesTable.targetType, targetType);
  const rows = await db.select().from(adminCockpitNotesTable)
    .where(where).orderBy(desc(adminCockpitNotesTable.isPinned), desc(adminCockpitNotesTable.createdAt)).limit(100);
  return rows.map((r) => ({
    id: r.id,
    targetType: r.targetType ?? null,
    targetUserId: r.targetUserId ?? null,
    authorId: r.adminUserId ?? null,
    authorRole: null,
    note: r.note,
    isPinned: r.isPinned,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// GET endpoints (read aggregation)
// ════════════════════════════════════════════════════════════════════════════

router.get("/admin/cockpit/overview", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;

  const [traderRows, investorRows, connections, openAgg, g, liveEnabled, alertAgg] = await Promise.all([
    computeTraderRows(),
    db.select({ status: investorProfilesTable.status }).from(investorProfilesTable),
    db.select({
      accountType: mt5ConnectionTable.accountType,
      lastHeartbeat: mt5ConnectionTable.lastHeartbeat,
    }).from(mt5ConnectionTable),
    db.select({
      cnt: sql<number>`cast(count(*) as int)`,
      floating: sql<number>`coalesce(sum(${arxLivePositionsTable.floatingPl}), 0)`,
    }).from(arxLivePositionsTable).where(isNull(arxLivePositionsTable.closedAt)),
    getGlobalSettings(),
    resolveLiveBrokerExecutionEnabledAsync().catch(() => false),
    db.select({
      open: sql<number>`cast(count(*) filter (where ${adminCockpitAlertsTable.status} = 'ACTIVE') as int)`,
      critical: sql<number>`cast(count(*) filter (where ${adminCockpitAlertsTable.status} = 'ACTIVE' and ${adminCockpitAlertsTable.alertLevel} = 'CRITICAL') as int)`,
    }).from(adminCockpitAlertsTable),
  ]);

  // Bridge = freshest-heartbeat connection.
  let freshest: { accountType: string; lastHeartbeat: Date | null } | null = null;
  for (const c of connections) {
    if (!freshest || (c.lastHeartbeat && (!freshest.lastHeartbeat || c.lastHeartbeat > freshest.lastHeartbeat))) {
      freshest = { accountType: c.accountType, lastHeartbeat: c.lastHeartbeat };
    }
  }
  const ageSec = heartbeatAgeSeconds(freshest?.lastHeartbeat ?? null);
  const bridgeConnected = ageSec != null && ageSec * 1000 <= BRIDGE_FRESH_MS;
  const acctType = (freshest?.accountType ?? "").toLowerCase();
  const bridgeLive = bridgeConnected && (acctType === "live" || acctType === "real");

  const open = openAgg[0];
  const alerts = alertAgg[0];

  return res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    traders: {
      total: traderRows.length,
      approvedLive: traderRows.filter((t) => t.liveStatus === "APPROVED" && t.approved).length,
      armed: traderRows.filter((t) => t.armed).length,
      suspended: traderRows.filter((t) => t.liveStatus === "SUSPENDED").length,
    },
    investors: {
      total: investorRows.length,
      active: investorRows.filter((i) => i.status === "active").length,
      frozen: investorRows.filter((i) => i.status === "paused").length,
    },
    bridge: {
      connected: bridgeConnected,
      live: bridgeLive,
      masterAccountType: freshest?.accountType ?? null,
      heartbeatAgeSeconds: ageSec,
    },
    exposure: {
      openPositions: open?.cnt ?? 0,
      totalFloatingPl: Number(open?.floating ?? 0),
    },
    capital: {
      poolNav: null,
      reservedRisk: null,
      availableAllocation: null,
    },
    safety: {
      liveExecutionEnabled: !!liveEnabled,
      killSwitchActive: !!g?.emergencyKillSwitch,
      platformMode: g?.platformMode ?? "OFF",
    },
    alerts: {
      open: alerts?.open ?? 0,
      critical: alerts?.critical ?? 0,
    },
  });
});

router.get("/admin/cockpit/traders", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const rows = await computeTraderRows();
  return res.json({ ok: true, rows });
});

router.get("/admin/cockpit/traders/:userId", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });

  const rows = await computeTraderRows();
  const trader = rows.find((r) => r.userId === userId);
  if (!trader) return res.status(404).json({ ok: false, error: "TRADER_NOT_FOUND" });

  const [liveState, openPositions, notes, recentAudit] = await Promise.all([
    buildApprovedTraderLiveState(userId).catch(() => null),
    db.select().from(arxLivePositionsTable)
      .where(and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)))
      .orderBy(desc(arxLivePositionsTable.openedAt)),
    loadNotes("trader", userId),
    loadAuditEntries(25, userId),
  ]);

  const isOwner = op.role === "OWNER";
  const openTrades = openPositions.map((p) => ({
    userId: p.userId,
    email: trader.email,
    symbol: p.symbol,
    side: p.side,
    volume: p.volume,
    brokerTicket: isOwner ? p.brokerTicket : null,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    floatingPl: p.floatingPl,
    openedAt: p.openedAt ? new Date(p.openedAt).toISOString() : null,
  }));

  return res.json({
    ok: true,
    trader,
    liveState: liveState as Record<string, unknown> | null,
    openTrades,
    notes,
    recentAudit,
  });
});

router.get("/admin/cockpit/investors", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;

  const [profiles, users, pool] = await Promise.all([
    db.select().from(investorProfilesTable),
    db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable),
    db.select().from(strategyPoolsTable).orderBy(strategyPoolsTable.id).limit(1),
  ]);
  const emailMap = new Map(users.map((u) => [u.id, u.email]));
  const nav = pool[0] ? await getPoolNav(pool[0].id) : null;
  const navPerUnit = nav?.navPerUnit ?? null;

  const holdings = pool[0]
    ? await db.select().from(investorPoolHoldingsTable).where(eq(investorPoolHoldingsTable.strategyPoolId, pool[0].id))
    : [];
  const holdingMap = new Map(holdings.map((h) => [h.userId, h]));

  const rows = profiles.map((p) => {
    const units = holdingMap.get(p.userId)?.unitsOwned ?? 0;
    return {
      userId: p.userId,
      email: emailMap.get(p.userId) ?? "",
      displayName: p.displayName ?? null,
      status: p.status,
      units,
      navPerUnit,
      holdingValue: navPerUnit != null ? units * navPerUnit : null,
      lockupUntil: null,
      pendingDeposits: null,
      pendingWithdrawals: null,
    };
  });

  return res.json({ ok: true, rows });
});

router.get("/admin/cockpit/investors/:userId", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });

  const [profileRows, userRows, pool] = await Promise.all([
    db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, userId)).limit(1),
    db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1),
    db.select().from(strategyPoolsTable).orderBy(strategyPoolsTable.id).limit(1),
  ]);
  const profile = profileRows[0];
  if (!profile) return res.status(404).json({ ok: false, error: "INVESTOR_NOT_FOUND" });

  const nav = pool[0] ? await getPoolNav(pool[0].id) : null;
  const navPerUnit = nav?.navPerUnit ?? null;
  const holding = pool[0]
    ? (await db.select().from(investorPoolHoldingsTable)
        .where(and(eq(investorPoolHoldingsTable.userId, userId), eq(investorPoolHoldingsTable.strategyPoolId, pool[0].id))).limit(1))[0]
    : undefined;
  const units = holding?.unitsOwned ?? 0;

  const [notes, recentAudit] = await Promise.all([
    loadNotes("investor", userId),
    loadAuditEntries(25, userId),
  ]);

  const investor = {
    userId,
    email: userRows[0]?.email ?? "",
    displayName: profile.displayName ?? null,
    status: profile.status,
    units,
    navPerUnit,
    holdingValue: navPerUnit != null ? units * navPerUnit : null,
    lockupUntil: null,
    pendingDeposits: null,
    pendingWithdrawals: null,
  };

  return res.json({
    ok: true,
    investor,
    finalized: {
      units,
      navPerUnit,
      value: navPerUnit != null ? units * navPerUnit : null,
    },
    indicative: {
      navPerUnit,
      value: navPerUnit != null ? units * navPerUnit : null,
    },
    pending: { deposits: null, withdrawals: null },
    notes,
    recentAudit,
  });
});

router.get("/admin/cockpit/bridge", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const isOwner = op.role === "OWNER";

  const [connections, users, providerHealth] = await Promise.all([
    db.select().from(mt5ConnectionTable),
    db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable),
    getProviderHealthSnapshot().catch(() => ({ providers: [] as unknown[] })),
  ]);
  const emailMap = new Map(users.map((u) => [u.id, u.email]));

  const rows = connections.map((c) => {
    const ageSec = heartbeatAgeSeconds(c.lastHeartbeat);
    const connected = ageSec != null && ageSec * 1000 <= BRIDGE_FRESH_MS;
    return {
      userId: c.userId ?? 0,
      email: c.userId ? (emailMap.get(c.userId) ?? null) : null,
      connected,
      accountType: c.accountType ?? null,
      eaVersion: c.eaVersion ?? null,
      heartbeatAgeSeconds: ageSec,
      // Not present in the heartbeat schema — honest null.
      terminalConnected: null,
      algoTradingAllowed: null,
      readOnlyMode: c.readOnlyMode,
      accountLogin: isOwner ? (c.accountNumber ?? null) : null,
      balance: isOwner ? (c.accountBalance ?? null) : null,
      equity: isOwner ? (c.accountEquity ?? null) : null,
      masked: !isOwner,
    };
  });

  const ph = (providerHealth as { providers?: unknown[] }).providers ?? [];
  return res.json({ ok: true, ownerView: isOwner, connections: rows, providerHealth: ph });
});

router.get("/admin/cockpit/open-trades", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const isOwner = op.role === "OWNER";

  const [positions, users] = await Promise.all([
    db.select().from(arxLivePositionsTable).where(isNull(arxLivePositionsTable.closedAt))
      .orderBy(desc(arxLivePositionsTable.openedAt)),
    db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable),
  ]);
  const emailMap = new Map(users.map((u) => [u.id, u.email]));

  let totalFloatingPl = 0;
  const rows = positions.map((p) => {
    totalFloatingPl += Number(p.floatingPl ?? 0);
    return {
      userId: p.userId,
      email: emailMap.get(p.userId) ?? null,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      brokerTicket: isOwner ? p.brokerTicket : null,
      entryPrice: p.entryPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      floatingPl: p.floatingPl ?? null,
      openedAt: p.openedAt ? new Date(p.openedAt).toISOString() : null,
    };
  });

  return res.json({ ok: true, rows, totalFloatingPl });
});

router.get("/admin/cockpit/risk-alerts", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const rows = await db.select().from(adminCockpitAlertsTable)
    .where(eq(adminCockpitAlertsTable.status, "ACTIVE"))
    .orderBy(desc(adminCockpitAlertsTable.createdAt)).limit(200);
  const alerts = rows.map((r) => ({
    id: String(r.id),
    severity: r.alertLevel,
    category: r.alertType,
    message: r.message,
    userId: r.targetUserId ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
  return res.json({ ok: true, alerts });
});

router.get("/admin/cockpit/capital", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;

  const [poolRows, openAgg] = await Promise.all([
    db.select().from(strategyPoolsTable).orderBy(strategyPoolsTable.id).limit(1),
    db.select({
      floating: sql<number>`coalesce(sum(${arxLivePositionsTable.floatingPl}), 0)`,
    }).from(arxLivePositionsTable).where(isNull(arxLivePositionsTable.closedAt)),
  ]);
  const pool = poolRows[0];
  const nav = pool ? await getPoolNav(pool.id) : null;
  const floatingPl = Number(openAgg[0]?.floating ?? 0);

  return res.json({
    ok: true,
    finalized: {
      poolNav: nav?.totalPoolValue ?? null,
      totalUnits: nav?.totalUnitsOutstanding ?? null,
      navPerUnit: nav?.navPerUnit ?? null,
    },
    indicative: {
      floatingPl,
      indicativeNav: null,
    },
    pending: { deposits: null, withdrawals: null },
    allocations: {
      poolSize: pool?.maxPoolCapital ?? null,
      assignedTotal: null,
      reservedRisk: null,
      available: null,
    },
  });
});

router.get("/admin/cockpit/audit-log", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const limit = parseInt(String(req.query.limit ?? "100"), 10);
  const entries = await loadAuditEntries(Number.isFinite(limit) ? limit : 100);
  return res.json({ ok: true, entries });
});

// ─── Pattern Sync (admin-only, advisory) ─────────────────────────────────────

function toPatternSyncCandles(candles: { time: string; open: number; high: number; low: number; close: number }[]): PatternSyncCandle[] {
  const out: PatternSyncCandle[] = [];
  for (const c of candles) {
    const t = Date.parse(c.time);
    if (!Number.isFinite(t)) continue;
    out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

router.get("/admin/cockpit/pattern-sync", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;

  const syntheticSymbols = market.ARX_FOCUS_MARKETS
    .filter((m) => m.category === "synthetic")
    .map((m) => m.canonicalSymbol);

  const inputs: PatternSyncSymbolInput[] = [];
  const engineBySymbol = new Map<string, PatternSyncEngineResult>();

  await Promise.all(syntheticSymbols.map(async (symbol) => {
    try {
      const [h4Res, m15Res] = await Promise.all([
        routeCandles(symbol, "H4", 150),
        routeCandles(symbol, "M15", 150),
      ]);
      const h4 = runPatternSyncEngine({
        symbol, timeframe: "H4", candles: toPatternSyncCandles(h4Res.candles),
      });
      const m15 = runPatternSyncEngine({
        symbol, timeframe: "M15", candles: toPatternSyncCandles(m15Res.candles),
      });
      inputs.push({ symbol, h4, m15 });
      engineBySymbol.set(symbol, h4);
    } catch {
      const empty = runPatternSyncEngine({ symbol, timeframe: "H4", candles: [] });
      inputs.push({ symbol, h4: empty, m15: null });
    }
  }));

  // Stable ordering (Promise.all resolves out of order).
  inputs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  const comparison = comparePatternSync(inputs, { timeframe: "H4" });

  const symbols = comparison.rows.map((r) => ({
    symbol: r.symbol,
    sufficient: r.sufficient,
    patternType: r.sufficient ? r.patternType : null,
    direction: r.sufficient ? r.trendBias : null,
    strengthScore: r.sufficient ? r.cleanSetupScore : null,
    clarityScore: r.sufficient ? Math.max(0, 100 - r.choppinessScore) : null,
    role: r.sufficient ? r.status : null,
    summary: r.summary,
    signature: null as string | null,
  }));

  // Pairwise structural match across sufficient symbols (advisory).
  const matches: { symbolA: string; symbolB: string; matchScore: number; aligned: boolean }[] = [];
  const sufficient = inputs.filter((i) => engineBySymbol.has(i.symbol) && i.h4.sufficient);
  for (let i = 0; i < sufficient.length; i++) {
    for (let j = i + 1; j < sufficient.length; j++) {
      const a = sufficient[i]!.h4;
      const b = sufficient[j]!.h4;
      matches.push({
        symbolA: sufficient[i]!.symbol,
        symbolB: sufficient[j]!.symbol,
        matchScore: patternMatchScore(a, b),
        aligned: a.trendBias === b.trendBias,
      });
    }
  }

  return res.json({
    ok: true,
    generatedAt: comparison.generatedAt,
    advisory: true,
    leaderSymbol: comparison.leaderSymbol,
    alignmentSummary: comparison.readableSummary,
    symbols,
    matches,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST endpoints (operator control — delegate + cockpit-audit)
// ════════════════════════════════════════════════════════════════════════════

router.post("/admin/cockpit/refresh", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_REFRESH", targetType: "global", ip: req.ip ?? null,
  });
  return res.json({ ok: true, refreshedAt: new Date().toISOString() });
});

function operatorAsMasterLiveActor(op: CockpitOperator): MasterLiveAdminActor {
  return { id: op.id, role: op.role };
}

router.post("/admin/cockpit/traders/:userId/approve", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const userRows = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!userRows[0]) return res.status(404).json({ ok: false, error: "TRADER_NOT_FOUND" });

  const result = await approveTraderForMasterLiveCore(
    operatorAsMasterLiveActor(op), userId, parsed.data.reason, req.ip ?? null, req.log,
  );

  if (result.kind === "not_in_beta") {
    return res.status(400).json({ ok: false, message: "User is not enrolled in the live beta cohort." });
  }
  if (result.kind === "cap") {
    return res.status(409).json({ ok: false, message: `Live approval cap reached (${result.approvedCount}).` });
  }

  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_APPROVE_TRADER", targetType: "trader", targetUserId: userId,
    beforeState: result.before, afterState: result.after, reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({ ok: true, newStatus: "APPROVED", message: "Trader approved for master-live." });
});

router.post("/admin/cockpit/traders/:userId/suspend", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const { before, after } = await changeMasterLiveStatusCore(
    operatorAsMasterLiveActor(op), userId, "SUSPENDED", "SUSPENDED",
    parsed.data.reason, req.ip ?? null,
    () => ({ masterLiveTradingEnabled: false, masterLiveDisabledBy: op.id, masterLiveDisabledAt: new Date() }),
  );
  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_SUSPEND_TRADER", targetType: "trader", targetUserId: userId,
    beforeState: before, afterState: after, reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({ ok: true, newStatus: "SUSPENDED", message: "Trader suspended from master-live." });
});

router.post("/admin/cockpit/traders/:userId/restore", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const userRows = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!userRows[0]) return res.status(404).json({ ok: false, error: "TRADER_NOT_FOUND" });

  const result = await approveTraderForMasterLiveCore(
    operatorAsMasterLiveActor(op), userId, parsed.data.reason, req.ip ?? null, req.log,
  );
  if (result.kind === "not_in_beta") {
    return res.status(400).json({ ok: false, message: "User is not enrolled in the live beta cohort." });
  }
  if (result.kind === "cap") {
    return res.status(409).json({ ok: false, message: `Live approval cap reached (${result.approvedCount}).` });
  }
  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_RESTORE_TRADER", targetType: "trader", targetUserId: userId,
    beforeState: result.before, afterState: result.after, reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({ ok: true, newStatus: "APPROVED", message: "Trader restored to master-live." });
});

router.post("/admin/cockpit/traders/:userId/full-activation", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = fullActivationBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  if (parsed.data.enabled) {
    const accessRows = await db.select().from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
    const access = accessRows[0];
    if (!access) return res.status(404).json({ ok: false, error: "TRADER_NOT_APPROVED" });
    const maxLot = (access as { maxLot?: number | null }).maxLot ?? null;
    const dailyLoss = (access as { dailyLossLimitUsd?: number | null }).dailyLossLimitUsd ?? null;
    if (maxLot == null || dailyLoss == null) {
      return res.status(409).json({ ok: false, message: "Trader caps (max lot / daily loss) are not set; cannot force-arm." });
    }
    await adminForceArmLiveForUser({
      userId, adminId: op.id, maxLotConfirmed: maxLot, dailyLossLimitConfirmed: dailyLoss, ip: req.ip ?? null,
    });
    await writeCockpitAudit({
      operator: op, actionType: "COCKPIT_FULL_ACTIVATION", targetType: "trader", targetUserId: userId,
      afterState: { armed: true, maxLot, dailyLoss }, reason: parsed.data.reason, ip: req.ip ?? null,
    });
    return res.json({ ok: true, message: "Trader force-armed for live. Dispatch still re-checks all Phase B gates." });
  }

  await disarmLiveForUser({ userId, reason: parsed.data.reason });
  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_FULL_ACTIVATION", targetType: "trader", targetUserId: userId,
    afterState: { armed: false }, reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({ ok: true, message: "Trader disarmed from live." });
});

router.post("/admin/cockpit/traders/:userId/emergency-close", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const summary = await runEmergencyClose({ kind: "user", userId }, "admin_cockpit");
  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_EMERGENCY_CLOSE", targetType: "trader", targetUserId: userId,
    afterState: {
      totalOpenMatched: summary.totalOpenMatched,
      queued: summary.queued, blocked: summary.blocked, errored: summary.errored,
    },
    reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({
    ok: true,
    closedCount: summary.queued,
    message: `Matched ${summary.totalOpenMatched} open position(s): ${summary.queued} queued to close, ${summary.blocked} blocked, ${summary.errored} errored.`,
  });
});

// ─── Investor freeze / unfreeze (replicates adminInvestors pause/resume) ──────

router.post("/admin/cockpit/investors/:userId/freeze", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const result = await db.transaction(async (tx) => {
    const rows = await tx.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, userId)).limit(1);
    const before = rows[0];
    if (!before) return { notFound: true as const };
    const [after] = await tx.update(investorProfilesTable)
      .set({ status: "paused", pausedReason: parsed.data.reason, pausedByAdminId: op.id, pausedAt: new Date() })
      .where(eq(investorProfilesTable.userId, userId)).returning();
    await tx.insert(adminActionAuditLogTable).values({
      adminId: op.id, adminRole: op.role, action: "INVESTOR_PAUSE", targetUserId: userId,
      beforeState: { status: before.status }, afterState: { status: "paused" }, reason: parsed.data.reason,
    });
    return { before, after };
  });
  if ("notFound" in result) return res.status(404).json({ ok: false, error: "INVESTOR_NOT_FOUND" });

  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_FREEZE_INVESTOR", targetType: "investor", targetUserId: userId,
    beforeState: { status: result.before.status }, afterState: { status: "paused" },
    reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({ ok: true, newStatus: "paused", message: "Investor frozen (capital movements paused)." });
});

router.post("/admin/cockpit/investors/:userId/unfreeze", async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const userId = parseUserIdParam(req);
  if (userId == null) return res.status(400).json({ ok: false, error: "BAD_USER_ID" });
  const parsed = reasonBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const result = await db.transaction(async (tx) => {
    const rows = await tx.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, userId)).limit(1);
    const before = rows[0];
    if (!before) return { notFound: true as const };
    const [after] = await tx.update(investorProfilesTable)
      .set({ status: "active", pausedReason: null, pausedByAdminId: null, pausedAt: null })
      .where(eq(investorProfilesTable.userId, userId)).returning();
    await tx.insert(adminActionAuditLogTable).values({
      adminId: op.id, adminRole: op.role, action: "INVESTOR_RESUME", targetUserId: userId,
      beforeState: { status: before.status }, afterState: { status: "active" }, reason: parsed.data.reason,
    });
    return { before, after };
  });
  if ("notFound" in result) return res.status(404).json({ ok: false, error: "INVESTOR_NOT_FOUND" });

  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_UNFREEZE_INVESTOR", targetType: "investor", targetUserId: userId,
    beforeState: { status: result.before.status }, afterState: { status: "active" },
    reason: parsed.data.reason, ip: req.ip ?? null,
  });
  return res.json({ ok: true, newStatus: "active", message: "Investor unfrozen." });
});

// ─── Manual operator note ────────────────────────────────────────────────────

router.post("/admin/cockpit/manual-note", express.json({ limit: "16kb" }), async (req, res) => {
  const op = requireOperator(req, res); if (!op) return;
  const parsed = manualNoteBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });

  const targetType = parsed.data.targetType === "platform" ? "global" : (parsed.data.targetType ?? "global");
  const [row] = await db.insert(adminCockpitNotesTable).values({
    adminUserId: op.id,
    targetType,
    targetUserId: parsed.data.targetUserId ?? null,
    note: parsed.data.note,
    isPinned: parsed.data.isPinned ?? false,
  }).returning();

  await writeCockpitAudit({
    operator: op, actionType: "COCKPIT_MANUAL_NOTE", targetType,
    targetUserId: parsed.data.targetUserId ?? null,
    metadata: { noteId: row!.id, isPinned: row!.isPinned }, ip: req.ip ?? null,
  });

  return res.json({
    ok: true,
    note: {
      id: row!.id,
      targetType: row!.targetType ?? null,
      targetUserId: row!.targetUserId ?? null,
      authorId: row!.adminUserId ?? null,
      authorRole: op.role,
      note: row!.note,
      isPinned: row!.isPinned,
      createdAt: new Date(row!.createdAt).toISOString(),
    },
  });
});

export default router;
