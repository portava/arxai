// Admin Bridge Allocations — Phase ALLOC
//
// SAFETY (inviolable):
// - These routes NEVER insert into arx_live_commands.
// - These routes NEVER modify kill switches, platform mode, or any of the
//   16 Phase B dispatch gates. They mutate ONLY user_slot_allocation rows.
// - All mutations are admin-only (role ∈ {ADMIN, OWNER}) and are written
//   append-only to admin_action_audit_log with beforeState/afterState.
// - Source of truth: user_slot_allocation (the active live shared-bridge
//   slot table). The legacy user_bridge_allocations table is NOT used.
// - Risk caps (allowed symbols, max lot, daily loss cap, SL requirement)
//   continue to live in user_risk_limits / arx_live_user_settings — this
//   route does not duplicate them.
// - When the master bridge heartbeat is stale, ADD operations refuse with
//   MASTER_BRIDGE_STALE so admins never over-allocate against a stale
//   snapshot.

import { Router, type Request, type Response } from "express";
import { and, desc, eq, ilike, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  userSlotAllocationTable,
  arxMasterAccountConfigTable,
  arxLivePositionsTable,
  adminActionAuditLogTable,
  mt5ConnectionTable,
  sharedMasterAccountsTable,
  virtualTradingAccountsTable,
  userMasterLiveAccessTable,
  userRiskLimitsTable,
  arxLiveUserSettingsTable,
  unattributedMasterTradesTable,
  type UserSlotAllocation,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { buildInvestorLiveBalanceSnapshot } from "../lib/live/investorLiveBalance.js";
import { openLiveExposureCondition } from "../lib/live/livePositionExposure.js";
import { mirrorCriticalEvent } from "../lib/security/events.js";
import { detectCurrentConnectedBridge } from "../lib/mt5/currentConnectedBridgeDetector.js";
import {
  recomputeMasterPool,
  loadMasterPool,
  reconcileAllocationsReservedRisk,
} from "../lib/live/masterBridgePool.js";
import {
  arxMasterBridgePoolTable,
} from "@workspace/db";

const router = Router();

// Task #1 — Shared bridge: MT5 is source of truth.
// Pre-checks the live master pool BEFORE the admin /add or /set
// allocation transaction commits. Returns the typed failure code that
// matches the task spec when the master snapshot is not safe to
// allocate against. Pure read; does NOT mutate anything inside the
// caller's transaction.
async function precheckMasterPoolForAllocation(): Promise<
  | { ok: true; pool: typeof arxMasterBridgePoolTable.$inferSelect }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const recompute = await recomputeMasterPool();
  if (!recompute.ok || !recompute.pool) {
    const reason = recompute.reason === "MASTER_BRIDGE_NOT_PINNED"
      ? "MASTER_BRIDGE_NOT_PINNED"
      : "MASTER_SNAPSHOT_MISSING";
    return { ok: false, status: 409, body: {
      ok: false, error: reason,
      message: reason === "MASTER_BRIDGE_NOT_PINNED"
        ? "No active master MT5 bridge is pinned."
        : "Master MT5 snapshot is not available yet.",
    } };
  }
  const pool = recompute.pool;
  if (pool.sharedLivePaused) {
    return { ok: false, status: 409, body: {
      ok: false, error: "SHARED_LIVE_PAUSED",
      message: pool.pausedReason ?? "Live shared trading is paused for reconciliation.",
    } };
  }
  if (pool.snapshotStatus === "MISSING") {
    return { ok: false, status: 409, body: {
      ok: false, error: "MASTER_SNAPSHOT_MISSING",
      message: "Master MT5 snapshot is missing.",
    } };
  }
  if (pool.snapshotStatus === "STALE") {
    return { ok: false, status: 409, body: {
      ok: false, error: "MASTER_SNAPSHOT_STALE",
      message: "Master MT5 snapshot is stale; wait for a fresh heartbeat.",
    } };
  }
  return { ok: true, pool };
}

const HEARTBEAT_LIVE_MS = 20_000;
const ADMIN_STALE_BUDGET_MS = 60_000;

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: u.id, role: u.role };
}

// ── Helpers ────────────────────────────────────────────────────────────────

type MasterContext = {
  configured: boolean;
  source: "pinned" | "auto-detected" | "none";
  masterConnectionId: number | null;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevelPct: number | null;
  currency: string | null;
  accountNumberMasked: string | null;
  brokerName: string | null;
  serverName: string | null;
  leverage: number | null;
  eaVersion: string | null;
  accountType: string | null;
  lastHeartbeatAt: string | null;
  lastHeartbeatAgeMs: number | null;
  isStale: boolean;
  hasRealBalance: boolean;
  detectorBlockedReason: string | null;
};

function mask(num: string | null | undefined): string | null {
  if (!num) return null;
  return num.length > 2 ? `••••${num.slice(-2)}` : num;
}

function summarizeConn(conn: typeof mt5ConnectionTable.$inferSelect, source: "pinned" | "auto-detected"): MasterContext {
  const ageMs = conn.lastHeartbeat ? Date.now() - new Date(conn.lastHeartbeat).getTime() : null;
  const balance = Number(conn.accountBalance ?? 0);
  const equity = Number(conn.accountEquity ?? 0);
  const margin = Number(conn.margin ?? 0);
  const freeMargin = Number(conn.freeMargin ?? 0);
  const marginLevelPct = margin > 0 ? round2((equity / margin) * 100) : null;
  return {
    configured: source === "pinned",
    source,
    masterConnectionId: conn.id,
    balance, equity, margin, freeMargin, marginLevelPct,
    currency: conn.accountCurrency ?? null,
    accountNumberMasked: mask(conn.accountNumber),
    brokerName: conn.brokerName ?? null,
    serverName: conn.serverName ?? null,
    leverage: conn.leverage ?? null,
    eaVersion: conn.eaVersion ?? null,
    accountType: conn.accountType ?? null,
    lastHeartbeatAt: conn.lastHeartbeat ? new Date(conn.lastHeartbeat).toISOString() : null,
    lastHeartbeatAgeMs: ageMs,
    isStale: ageMs == null || ageMs > ADMIN_STALE_BUDGET_MS,
    hasRealBalance: balance > 0 || equity > 0,
    detectorBlockedReason: null,
  };
}

// Reads the live MT5 account snapshot for the master bridge. Order:
//  1. If an `arx_master_account_config` row is active, read that mt5_connection.
//  2. Else fall back to `detectCurrentConnectedBridge()` — if it returns
//     a healthy LIVE bridge, surface its real balance/equity/freeMargin as
//     the effective master (`source: 'auto-detected'`, `configured: false`).
// Real balance is NEVER overwritten with zero just because the pin row is
// missing or a refresh fails.
async function getMasterContext(): Promise<MasterContext> {
  const configs = await db.select().from(arxMasterAccountConfigTable)
    .where(eq(arxMasterAccountConfigTable.isActive, true)).limit(1);
  const config = configs[0];
  if (config) {
    const conns = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, config.masterConnectionId)).limit(1);
    const conn = conns[0];
    if (conn) return summarizeConn(conn, "pinned");
    // Pinned row points at a deleted connection — fall through to detector.
  }
  const det = await detectCurrentConnectedBridge();
  if (det.ok) {
    const conns = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, det.bridge.bridgeId)).limit(1);
    const conn = conns[0];
    if (conn) return summarizeConn(conn, "auto-detected");
  }
  const blocked = !det.ok ? det.primaryReason : null;
  return {
    configured: false, source: "none", masterConnectionId: null,
    balance: 0, equity: 0, margin: 0, freeMargin: 0, marginLevelPct: null,
    currency: null, accountNumberMasked: null, brokerName: null, serverName: null,
    leverage: null, eaVersion: null, accountType: null,
    lastHeartbeatAt: null, lastHeartbeatAgeMs: null, isStale: true,
    hasRealBalance: false, detectorBlockedReason: blocked,
  };
}

// Pull realised + open P/L for one user from arx_live_positions.
async function getUserPnl(userId: number): Promise<{ realisedPnl: number; openPnL: number; openCount: number }> {
  const open = await db.select({ pl: arxLivePositionsTable.floatingPl })
    .from(arxLivePositionsTable)
    .where(openLiveExposureCondition(userId));
  const closed = await db.select({ pl: arxLivePositionsTable.floatingPl })
    .from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, userId), isNotNull(arxLivePositionsTable.closedAt)));
  const openPnL = open.reduce((s, r) => s + Number(r.pl ?? 0), 0);
  const realisedPnl = closed.reduce((s, r) => s + Number(r.pl ?? 0), 0);
  return { realisedPnl, openPnL, openCount: open.length };
}

// Normalise a row to the shape the admin UI expects. Maps the slot
// allocation columns + derived P/L into the historic UserAlloc payload so
// the existing UI table renders without changes. NO sensitive operator
// fields are returned (no notes, no assignedByUserId, no frozenByUserId).
function shapeAlloc(row: UserSlotAllocation, opts: {
  email: string | null;
  bridgeConnectionId: number | null;
  realisedPnl: number;
  openPnL: number;
  usedMargin: number;
}) {
  const total = Number(row.allocatedFunds);
  let manual = Number(row.manualAllocatedFunds);
  let ai = Number(row.aiAllocatedFunds);
  // Backfill: if the row was created before the manual/ai split existed,
  // surface the entire total as manual so the UI shows it correctly.
  if (manual + ai === 0 && total > 0) manual = total;
  const slotBalance = total + opts.realisedPnl;
  const available = Math.max(0, slotBalance - opts.usedMargin);
  return {
    id: row.id,
    userId: row.userId,
    email: opts.email,
    bridgeConnectionId: opts.bridgeConnectionId,
    totalAllocation: total,
    manualAllocationBalance: manual,
    aiManagedAllocationBalance: ai,
    availableBalance: available,
    reservedRisk: opts.usedMargin,
    realizedPnl: opts.realisedPnl,
    unrealizedPnl: opts.openPnL,
    aiAvailableBalance: Math.max(0, ai),
    aiAutoTradingEnabled: row.aiAutoTradingEnabled,
    aiWatchOnly: row.aiStrategyMode === "watch_only",
    aiStrategyMode: row.aiStrategyMode,
    aiMaxLot: row.aiMaxLot != null ? Number(row.aiMaxLot) : null,
    aiMaxOpenTrades: null as number | null,
    aiMaxDailyLoss: row.aiMaxDailyLossUsd != null ? Number(row.aiMaxDailyLossUsd) : null,
    allocationStatus: row.allocationStatus,
    tradingFrozen: row.tradingFrozen,
    aiTradingFrozen: row.aiTradingFrozen,
    closeOnlyMode: row.closeOnlyMode,
    freezeReason: row.freezeReason,
    frozenAt: row.frozenAt ? new Date(row.frozenAt).toISOString() : null,
    currency: row.accountCurrency,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString(),
  };
}

// Pure read — never inserts. Returns null when no allocation row exists yet.
// Mutators MUST seed a row inside their own transaction (`seedAllocInTx`) so
// no row is ever persisted without a paired admin_action_audit_log entry.
async function loadAlloc(userId: number): Promise<UserSlotAllocation | null> {
  const rows = await db.select().from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Always FOR UPDATE inside a mutating transaction so concurrent admin
// mutations on the same user serialize at the row level. Without this,
// two parallel ADDs could each derive from the same stale baseline and
// the second commit would silently overwrite the first while the audit
// log records both as successful.
async function loadAllocInTx(tx: Tx, userId: number): Promise<UserSlotAllocation | null> {
  const rows = await tx.select().from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId))
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

// Transfer locks two user rows. Lock them in deterministic ascending
// userId order so a concurrent transfer in the opposite direction cannot
// deadlock against this one.
async function loadTwoAllocsForUpdate(tx: Tx, userA: number, userB: number): Promise<{
  a: UserSlotAllocation | null;
  b: UserSlotAllocation | null;
}> {
  const [first, second] = userA < userB ? [userA, userB] : [userB, userA];
  const firstRow = await loadAllocInTx(tx, first);
  const secondRow = await loadAllocInTx(tx, second);
  return userA < userB
    ? { a: firstRow, b: secondRow }
    : { a: secondRow, b: firstRow };
}

async function seedAllocInTx(tx: Tx, userId: number, actorId: number): Promise<UserSlotAllocation> {
  const [created] = await tx.insert(userSlotAllocationTable).values({
    userId,
    allocatedFunds: 0,
    manualAllocatedFunds: 0,
    aiAllocatedFunds: 0,
    isActive: true,
    assignedByUserId: actorId,
  }).returning();
  return created!;
}

// Normalize legacy rows written before manual/ai split existed: if both
// buckets are zero but the row carries a positive total, the entire total
// belongs to the manual sleeve. Returns the effective baseline used as the
// starting point for every mutation so we never lose the historical
// manual portion of a pre-split row.
function normalizeSplit(row: UserSlotAllocation): {
  total: number; manual: number; ai: number;
} {
  const total = Number(row.allocatedFunds);
  let manual = Number(row.manualAllocatedFunds);
  let ai = Number(row.aiAllocatedFunds);
  if (manual + ai === 0 && total > 0) manual = total;
  return { total, manual, ai };
}

async function audit(args: {
  admin: { id: number; role: "ADMIN" | "OWNER" };
  action: string;
  targetUserId: number | null;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  reason?: string | null;
  ipAddress?: string | null;
}) {
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason ?? null,
    ipAddress: args.ipAddress ?? null,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Legacy data carries both 'active' and 'ACTIVE' in virtual_trading_accounts.status.
// Every "is attached?" check across this file routes through this predicate so a
// case-mismatched row can never silently disappear from the admin view or the
// attached-user exclusion set.
function vtaStatusActive() {
  return sql`lower(${virtualTradingAccountsTable.status}) = 'active'`;
}

function ipOf(req: Request): string | null {
  const v = req.ip as string | string[] | undefined;
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function paramStr(req: Request, key: string): string {
  const v = req.params[key];
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

// ── GET /api/admin/allocations ─────────────────────────────────────────────
router.get("/admin/allocations", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const master = await getMasterContext();

  const allocRows = await db.select({
    alloc: userSlotAllocationTable,
    email: usersTable.email,
  })
    .from(userSlotAllocationTable)
    .leftJoin(usersTable, eq(usersTable.id, userSlotAllocationTable.userId))
    .orderBy(desc(userSlotAllocationTable.updatedAt));

  // Users who are attached to a shared master (have a SHARED_MASTER VTA
  // row with a real sharedMasterAccountId) but have NO user_slot_allocation
  // row. Without this union the admin allocations page silently hides them
  // — yet the eligible-search excludes them as "already attached", which
  // is the contradiction the user reported. We synthesise a zero-alloc
  // row so they appear with the full action set (Add/Set/Refresh/Detach).
  const allocUserIdSet = new Set(allocRows.map((r) => r.alloc.userId));
  const attachedRows = await db.select({ userId: virtualTradingAccountsTable.userId })
    .from(virtualTradingAccountsTable)
    .where(and(
      eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
      vtaStatusActive(),
      isNotNull(virtualTradingAccountsTable.sharedMasterAccountId),
    ));
  const orphanAttachedIds = Array.from(new Set(
    attachedRows.map((r) => r.userId).filter((id) => !allocUserIdSet.has(id)),
  ));
  const orphanUsers = orphanAttachedIds.length
    ? await db.select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable).where(inArray(usersTable.id, orphanAttachedIds))
    : [];
  const orphanRows = orphanUsers.map((u) => ({
    // Synthetic zero-alloc shape — NEVER persisted. We deliberately do
    // not auto-seed an allocation row on a read; the row materialises
    // only when admin actually calls Add/Set (those handlers seed).
    alloc: {
      id: -u.id, userId: u.id,
      allocatedFunds: "0", manualAllocatedFunds: "0", aiAllocatedFunds: "0",
      isActive: true, allocationStatus: "active" as const,
      tradingFrozen: false, aiTradingFrozen: false, closeOnlyMode: false,
      aiAutoTradingEnabled: false, aiStrategyMode: "watch_only" as const,
      aiMaxLot: null, aiMaxDailyLossUsd: null,
      freezeReason: null, assignedByUserId: null, frozenByUserId: null,
      notes: null, createdAt: new Date(0), updatedAt: new Date(0),
    } as unknown as UserSlotAllocation,
    email: u.email,
  }));

  const rows = [...allocRows, ...orphanRows];
  const userIds = rows.map((r) => r.alloc.userId);
  // Batched lookups: one query each instead of N per page render.
  const vtaRows = userIds.length
    ? await db.select().from(virtualTradingAccountsTable).where(and(
        inArray(virtualTradingAccountsTable.userId, userIds),
        eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
        isNotNull(virtualTradingAccountsTable.sharedMasterAccountId),
      ))
    : [];
  const mlaRows = userIds.length
    ? await db.select({
        userId: userMasterLiveAccessTable.userId,
        masterLiveStatus: userMasterLiveAccessTable.masterLiveStatus,
        approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
        dailyLossLimitUsd: userMasterLiveAccessTable.dailyLossLimitUsd,
      }).from(userMasterLiveAccessTable).where(inArray(userMasterLiveAccessTable.userId, userIds))
    : [];
  // Per-user daily-loss cap, resolved with the same precedence the Phase B
  // live gate uses: arx_live_user_settings → master live access →
  // user_risk_limits. The first POSITIVE value wins. If none is known/
  // positive, the cap stays null and NO at-risk flag is shown for that user
  // (never fabricate a cap).
  const liveSettingsRows = userIds.length
    ? await db.select({
        userId: arxLiveUserSettingsTable.userId,
        dailyLossLimitUsd: arxLiveUserSettingsTable.dailyLossLimitUsd,
      }).from(arxLiveUserSettingsTable).where(inArray(arxLiveUserSettingsTable.userId, userIds))
    : [];
  const riskLimitRows = userIds.length
    ? await db.select({
        userId: userRiskLimitsTable.userId,
        maxDailyLossUsd: userRiskLimitsTable.maxDailyLossUsd,
      }).from(userRiskLimitsTable).where(inArray(userRiskLimitsTable.userId, userIds))
    : [];
  const liveSettingsByUser = new Map<number, number>();
  for (const s of liveSettingsRows) liveSettingsByUser.set(s.userId, Number(s.dailyLossLimitUsd ?? 0));
  const riskLimitByUser = new Map<number, number>();
  for (const s of riskLimitRows) riskLimitByUser.set(s.userId, Number(s.maxDailyLossUsd ?? 0));
  const vtaByUser = new Map<number, typeof virtualTradingAccountsTable.$inferSelect>();
  for (const v of vtaRows) {
    // Prefer the active row when multiple exist (legacy data could have closed rows too).
    const prev = vtaByUser.get(v.userId);
    // Case-insensitive: legacy rows carry both 'active' and 'ACTIVE'.
    const prevActive = prev ? prev.status.toLowerCase() === "active" : false;
    const vActive = v.status.toLowerCase() === "active";
    if (!prev || (!prevActive && vActive)) vtaByUser.set(v.userId, v);
  }
  const mlaByUser = new Map<number, typeof mlaRows[number]>();
  for (const m of mlaRows) mlaByUser.set(m.userId, m);

  const shaped = await Promise.all(rows.map(async (r) => {
    const pnl = await getUserPnl(r.alloc.userId);
    // Task #430 — canonical mark-to-market per investor, the SAME snapshot the
    // user's own Dashboard reads, so the admin table never disagrees with what
    // the investor sees. Honest: floating is null when unavailable.
    const inv = await buildInvestorLiveBalanceSnapshot(r.alloc.userId);
    // Used-margin estimate is held as 0 until per-position margin is wired;
    // surfacing reservedRisk=0 is more honest than a fabricated number.
    const base = shapeAlloc(r.alloc, {
      email: r.email,
      bridgeConnectionId: master.masterConnectionId,
      realisedPnl: pnl.realisedPnl,
      openPnL: pnl.openPnL,
      usedMargin: 0,
    });
    const vta = vtaByUser.get(r.alloc.userId);
    const mla = mlaByUser.get(r.alloc.userId);
    const attached = !!vta && vta.status.toLowerCase() === "active";
    const virtualBalance = vta ? round2(Number(vta.virtualBalance)) : 0;
    const virtualEquity = vta ? round2(Number(vta.virtualEquity)) : 0;
    // shellSynced = principal portion (virtualBalance - virtualPnl) matches allocatedFunds.
    const principal = vta ? round2(Number(vta.virtualBalance) - Number(vta.virtualPnl)) : 0;
    const shellSynced = attached && Math.abs(principal - base.totalAllocation) < 0.01;
    // First positive cap wins; null means "unknown" → UI shows no flag.
    const capCandidates = [
      liveSettingsByUser.get(r.alloc.userId) ?? 0,
      Number(mla?.dailyLossLimitUsd ?? 0),
      riskLimitByUser.get(r.alloc.userId) ?? 0,
    ];
    const resolvedCap = capCandidates.find((c) => c > 0) ?? null;
    return {
      ...base,
      openPositionsCount: pnl.openCount,
      dailyLossLimitUsd: resolvedCap != null ? round2(resolvedCap) : null,
      // Task #430 — canonical live block (single source of truth, per investor).
      live: {
        source: inv.source,
        allocatedBalance: inv.allocatedBalance,
        realizedPnL: inv.realizedPnL,
        floatingPnL: inv.floatingPnL,
        liveEquity: inv.liveEquity,
        marginUsed: inv.marginUsed,
        freeMargin: inv.freeMargin,
        availableBalance: inv.availableBalance,
        openTradeCount: inv.openTradeCount,
        freshness: inv.freshness,
      },
      attachment: {
        attached,
        sharedMasterAccountId: vta?.sharedMasterAccountId ?? null,
        virtualAccountId: vta?.id ?? null,
        virtualBalance,
        virtualEquity,
        shellSynced,
        status: vta?.status ?? null,
        masterLiveStatus: mla?.masterLiveStatus ?? null,
        approvedForMasterLive: mla?.approvedForMasterLive ?? false,
      },
    };
  }));

  const totalAllocated = shaped.reduce((s, a) => s + a.totalAllocation, 0);
  const totalFrozen = shaped
    .filter((a) => a.allocationStatus === "frozen" || a.tradingFrozen)
    .reduce((s, a) => s + a.totalAllocation, 0);
  const frozenCount = shaped.filter((a) => a.allocationStatus === "frozen" || a.tradingFrozen).length;

  // Task #430 — master totals rolled up from the canonical per-investor blocks.
  // Floating is summed only over investors whose floating is actually available;
  // when ANY in-live investor's floating is unavailable, floatingResolved=false
  // tells the UI not to present the aggregate floating/equity as fully live.
  const liveBlocks = shaped.map((a) => a.live);
  const totalRealizedPnL = round2(liveBlocks.reduce((s, b) => s + b.realizedPnL, 0));
  const totalFloatingPnL = round2(
    liveBlocks.reduce((s, b) => s + (b.floatingPnL ?? 0), 0),
  );
  const totalLiveEquity = round2(liveBlocks.reduce((s, b) => s + b.liveEquity, 0));
  const totalOpenTradeCount = liveBlocks.reduce((s, b) => s + b.openTradeCount, 0);
  const floatingResolved = !liveBlocks.some(
    (b) => b.source === "live_shared" && b.openTradeCount > 0 && b.floatingPnL == null,
  );

  // Admin-only Unmapped Open Trades bucket — master fills the reconciler could
  // not attribute to any investor. READ ONLY: surfaced for review; never
  // auto-assigned to a user here (linking is an explicit admin action elsewhere).
  const unmappedRows = await db
    .select()
    .from(unattributedMasterTradesTable)
    .where(eq(unattributedMasterTradesTable.status, "pending_review"))
    .orderBy(desc(unattributedMasterTradesTable.createdAt))
    .limit(200);
  const unmappedOpenTrades = {
    count: unmappedRows.length,
    items: unmappedRows.map((u) => ({
      id: u.id,
      symbol: u.symbol,
      side: u.side,
      lotSize: u.lotSize,
      fillPrice: u.fillPrice,
      source: u.source,
      mt5PositionTicket: u.mt5PositionTicket,
      brokerMessage: u.brokerMessage,
      executedAt: u.executedAt ? new Date(u.executedAt).toISOString() : null,
      createdAt: new Date(u.createdAt).toISOString(),
    })),
  };

  res.json({
    ok: true,
    users: shaped,
    summary: {
      totalAllocated: round2(totalAllocated),
      totalFrozen: round2(totalFrozen),
      userCount: shaped.length,
      frozenCount,
      // Canonical master totals (mark-to-market).
      totalRealizedPnL,
      totalFloatingPnL,
      totalLiveEquity,
      totalOpenTradeCount,
      floatingResolved,
    },
    unmappedOpenTrades,
    master: {
      // `configured` = pinned in arx_master_account_config.
      // `available`  = either pinned OR auto-detected with real balance.
      //                Mutators (Add/Set/Transfer) allow when available=true.
      configured: master.source === "pinned",
      available: master.hasRealBalance,
      source: master.source,
      masterConnectionId: master.masterConnectionId,
      balance: round2(master.balance),
      equity: round2(master.equity),
      margin: round2(master.margin),
      freeMargin: round2(master.freeMargin),
      marginLevelPct: master.marginLevelPct,
      currency: master.currency,
      accountNumberMasked: master.accountNumberMasked,
      brokerName: master.brokerName,
      serverName: master.serverName,
      leverage: master.leverage,
      eaVersion: master.eaVersion,
      accountType: master.accountType,
      lastHeartbeatAt: master.lastHeartbeatAt,
      lastHeartbeatAgeMs: master.lastHeartbeatAgeMs,
      isStale: master.isStale,
      // Headroom = master balance - already allocated. Negative = over-allocated.
      headroom: master.hasRealBalance ? round2(master.balance - totalAllocated) : null,
      detectorBlockedReason: master.detectorBlockedReason,
    },
  });
});

// ── GET /api/admin/allocations/:userId/history ────────────────────────────
router.get("/admin/allocations/:userId/history", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
    return;
  }
  const rows = await db.select({
    id: adminActionAuditLogTable.id,
    adminId: adminActionAuditLogTable.adminId,
    adminRole: adminActionAuditLogTable.adminRole,
    action: adminActionAuditLogTable.action,
    beforeState: adminActionAuditLogTable.beforeState,
    afterState: adminActionAuditLogTable.afterState,
    reason: adminActionAuditLogTable.reason,
    createdAt: adminActionAuditLogTable.createdAt,
  })
    .from(adminActionAuditLogTable)
    .where(and(
      eq(adminActionAuditLogTable.targetUserId, userId),
      sql`${adminActionAuditLogTable.action} LIKE 'ALLOCATION_%'`,
    ))
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(100);
  res.json({ ok: true, transactions: rows });
});

// ── POST /api/admin/allocations/pin-master ────────────────────────────────
// Explicit one-click pin. Reads the currently auto-detected live bridge,
// writes (or refreshes) the active arx_master_account_config row. Does
// NOT enable trading, modify gates, or touch any user allocation. Purely
// flips `master.source` from 'auto-detected' to 'pinned' so subsequent
// reads short-circuit on the config row instead of the detector.
router.post("/admin/allocations/pin-master", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = z.object({ label: z.string().max(200).optional(), notes: z.string().max(500).optional() })
    .safeParse(req.body ?? {});
  const label = body.success ? body.data.label ?? null : null;
  const notes = body.success ? body.data.notes ?? null : null;

  const det = await detectCurrentConnectedBridge();
  if (!det.ok) {
    res.status(409).json({ ok: false, error: "NO_DETECTED_MASTER_BRIDGE", reason: det.primaryReason });
    return;
  }
  const targetConnectionId = det.bridge.bridgeId;

  const result = await db.transaction(async (tx) => {
    const conns = await tx.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, targetConnectionId)).limit(1);
    const conn = conns[0];
    if (!conn) return fail(409, { ok: false, error: "DETECTED_CONNECTION_MISSING" });

    const existing = await tx.select().from(arxMasterAccountConfigTable)
      .where(eq(arxMasterAccountConfigTable.isActive, true)).for("update").limit(1);
    const prior = existing[0] ?? null;
    if (prior && prior.masterConnectionId === targetConnectionId) {
      // Already pinned to this connection. No-op write to refresh updatedAt.
      const [updated] = await tx.update(arxMasterAccountConfigTable)
        .set({ updatedAt: new Date(), label: label ?? prior.label, notes: notes ?? prior.notes })
        .where(eq(arxMasterAccountConfigTable.id, prior.id)).returning();
      return { ok: true as const, pinned: updated, alreadyPinned: true };
    }
    if (prior) {
      await tx.update(arxMasterAccountConfigTable).set({ isActive: false, updatedAt: new Date() })
        .where(eq(arxMasterAccountConfigTable.id, prior.id));
    }
    const [inserted] = await tx.insert(arxMasterAccountConfigTable).values({
      masterConnectionId: targetConnectionId,
      label: label ?? `Master bridge ${conn.accountNumber ?? conn.id}`,
      isActive: true,
      notes,
    }).returning();
    await auditInTx(tx, {
      admin,
      action: "ALLOCATION_PIN_MASTER",
      targetUserId: 0,
      beforeState: prior ? { masterConnectionId: prior.masterConnectionId } : { masterConnectionId: null },
      afterState: { masterConnectionId: targetConnectionId, accountNumber: conn.accountNumber, brokerName: conn.brokerName },
      reason: notes ?? null,
      ipAddress: ipOf(req),
    });
    return { ok: true as const, pinned: inserted, alreadyPinned: false };
  });
  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  if (!result.alreadyPinned) {
    await mirrorAllocationChange(admin, "ALLOCATION_PIN_MASTER", 0, null);
  }
  res.json(result);
});

// ── Mutation helpers ──────────────────────────────────────────────────────
//
// Every mutating handler runs inside a single `db.transaction(...)`. Within
// the tx we:
//   1. Lock the master config row with SELECT ... FOR UPDATE for any
//      mutation that depends on master capacity (ADD, SET). This serialises
//      headroom enforcement across concurrent admin requests so two
//      operators cannot both pass the cap check and over-allocate.
//   2. Re-read the user row inside the tx (TOCTOU guard) and seed it only
//      if every validation has passed so far. No row is ever persisted
//      without a paired admin_action_audit_log entry.
//   3. Normalize legacy rows (manual=0, ai=0, total>0 → manual=total)
//      before computing the new state, so a pre-split row keeps its
//      historical manual portion in the split accounting after a mutation.
//   4. Insert the audit row in the same transaction as the data mutation.
//      Either both land or neither does.

// Single process-wide serialization point for EVERY allocation-capacity
// mutation. Taking this advisory xact lock at the top of each mutating tx
// (Add/Set/Remove/Transfer/Reduce/ReduceProportional + the SYSTEM
// auto-reconcile) guarantees they can never run concurrently, which removes
// any row-lock ordering hazard between paths that lock multiple
// user_slot_allocation rows in different orders (e.g. transfer locks two rows
// in userId order while auto-reconcile locks all rows in id order — without a
// shared serialization point those two orders can deadlock). The namespace
// key is an arbitrary stable bigint scoped to allocations.
async function acquireAllocationSerializationLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(74220001, 1)`);
}

async function loadMasterContextInTxForUpdate(tx: Tx): Promise<{
  configured: boolean;          // true if mutators may proceed (real master available)
  pinned: boolean;              // true only if arx_master_account_config has an active row
  source: "pinned" | "auto-detected" | "none";
  masterConnectionId: number | null;
  balance: number;
  equity: number;
  freeMargin: number;
  isStale: boolean;
  hasRealBalance: boolean;
}> {
  // Serialise ALL capacity-mutating paths across the entire process, even
  // when no arx_master_account_config row exists yet (auto-detected master).
  // The FOR UPDATE below only locks a row if one is present, so without
  // this advisory lock two concurrent Add/Set calls in the auto-detected
  // state could both pass the headroom check and over-allocate.
  await acquireAllocationSerializationLock(tx);

  // Lock the master config row (if any). Concurrent ADD/SET handlers
  // already serialize on the advisory lock above; this still narrows the
  // window for the pinned-row case and stays compatible with prior reads.
  const configs = await tx.select().from(arxMasterAccountConfigTable)
    .where(eq(arxMasterAccountConfigTable.isActive, true))
    .for("update")
    .limit(1);
  const config = configs[0];

  const summarize = (
    conn: typeof mt5ConnectionTable.$inferSelect,
    source: "pinned" | "auto-detected",
  ) => {
    const ageMs = conn.lastHeartbeat ? Date.now() - new Date(conn.lastHeartbeat).getTime() : null;
    const balance = Number(conn.accountBalance ?? 0);
    const equity = Number(conn.accountEquity ?? 0);
    return {
      configured: true,
      pinned: source === "pinned",
      source,
      masterConnectionId: conn.id,
      balance,
      equity,
      freeMargin: Number(conn.freeMargin ?? 0),
      isStale: ageMs == null || ageMs > ADMIN_STALE_BUDGET_MS,
      hasRealBalance: balance > 0 || equity > 0,
    };
  };

  if (config) {
    const conns = await tx.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, config.masterConnectionId)).limit(1);
    const conn = conns[0];
    if (conn) return summarize(conn, "pinned");
    // Pinned row dangles — fall through to detector.
  }
  // Fall back to the live-bridge detector. Same one /api/admin/master-bridge/current
  // uses. Funding against a detected (unpinned) bridge is safe because the
  // capacity check below is against the real broker-reported balance.
  const det = await detectCurrentConnectedBridge();
  if (det.ok) {
    const conns = await tx.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.id, det.bridge.bridgeId)).limit(1);
    const conn = conns[0];
    if (conn) return summarize(conn, "auto-detected");
  }
  return {
    configured: false, pinned: false, source: "none",
    masterConnectionId: null, balance: 0, equity: 0, freeMargin: 0,
    isStale: true, hasRealBalance: false,
  };
}

async function sumAllocatedInTx(tx: Tx): Promise<number> {
  const all = await tx.select({ a: userSlotAllocationTable.allocatedFunds })
    .from(userSlotAllocationTable);
  return all.reduce((s, r) => s + Number(r.a), 0);
}

async function auditInTx(tx: Tx, args: Parameters<typeof audit>[0]) {
  await tx.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason ?? null,
    ipAddress: args.ipAddress ?? null,
  });
}

// Tamper-evident mirror of a capacity-mutating allocation change. Called
// POST-COMMIT only (never inside the allocation transaction) so it can neither
// hold the allocation row/advisory locks while it runs nor write an orphan
// chain row if the host transaction rolls back. Best-effort + fail-open:
// runs on its own pooled connection and never throws.
export async function mirrorAllocationChange(
  admin: { id: number; role: string },
  action: string,
  targetUserId: number | null,
  reason?: string | null,
): Promise<void> {
  await mirrorCriticalEvent({
    eventType: "ALLOCATION_CHANGE", severity: "HIGH", status: "ALLOWED",
    actorUserId: admin.id, actorRole: admin.role, actorType: admin.role,
    affectedObject: targetUserId != null ? `user:${targetUserId}` : "allocation:pool",
    message: `Allocation change: ${action}`,
    metadata: { action, targetUserId: targetUserId ?? null, reason: reason ?? null },
  });
}

// Sentinel returned from inside a transaction to signal an HTTP error. The
// outer handler maps it to the right status code. Throwing would also work
// but pollutes logs; this keeps validation failures clean.
type TxFailure = { __fail: true; status: number; body: Record<string, unknown> };
function fail(status: number, body: Record<string, unknown>): TxFailure {
  return { __fail: true, status, body };
}
function isTxFailure(x: unknown): x is TxFailure {
  return typeof x === "object" && x !== null && (x as { __fail?: boolean }).__fail === true;
}

// ── Shared-master attachment helpers ─────────────────────────────────────────
//
// These helpers wire the admin allocation flow into the user-facing account
// shell (computeAccountShell reads virtual_trading_accounts). NONE of them
// place trades, modify any of the 16 Phase B gates, or insert into
// arx_live_commands. They only:
//   - find-or-create the shared_master_accounts row for the active master
//     mt5_connection (one row per (connectionId)).
//   - find-or-reactivate the virtual_trading_accounts row for
//     (userId, sharedMasterAccountId, accountType='demo').
//   - delta-sync virtualBalance/virtualEquity by the same dollar amount the
//     admin changed in user_slot_allocation, so the user shell stops
//     showing zero. Existing virtualPnl (set by virtualPnlSync from closed
//     trades) is preserved — we never overwrite it from this code path.

async function ensureSharedMasterAccountInTx(
  tx: Tx,
  masterConnectionId: number,
  accountType: "demo" | "live" = "demo",
): Promise<number> {
  const existing = await tx.select({ id: sharedMasterAccountsTable.id })
    .from(sharedMasterAccountsTable)
    .where(eq(sharedMasterAccountsTable.connectionId, masterConnectionId))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const conn = await tx.select({
    accountNumber: mt5ConnectionTable.accountNumber,
    brokerName: mt5ConnectionTable.brokerName,
  }).from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, masterConnectionId)).limit(1);
  const masked = conn[0]?.accountNumber
    ? (conn[0].accountNumber.length > 2 ? `••••${conn[0].accountNumber.slice(-2)}` : conn[0].accountNumber)
    : null;
  // ON CONFLICT DO NOTHING + re-read. The unique index on connectionId
  // (`shared_master_accounts_connection_uidx`) means two concurrent
  // first-time attaches would otherwise race on the insert and one would
  // bubble a 500. With ON CONFLICT, the loser harmlessly no-ops and
  // re-reads the winner's id.
  const inserted = await tx.insert(sharedMasterAccountsTable).values({
    connectionId: masterConnectionId,
    accountType,
    brokerName: conn[0]?.brokerName ?? null,
    accountNumberMasked: masked,
    status: "active",
    isActive: true,
  }).onConflictDoNothing({ target: sharedMasterAccountsTable.connectionId })
    .returning({ id: sharedMasterAccountsTable.id });
  if (inserted[0]) return inserted[0].id;
  const after = await tx.select({ id: sharedMasterAccountsTable.id })
    .from(sharedMasterAccountsTable)
    .where(eq(sharedMasterAccountsTable.connectionId, masterConnectionId))
    .limit(1);
  if (!after[0]) throw new Error("ensureSharedMasterAccountInTx: race-after-conflict re-read empty");
  return after[0].id;
}

// Idempotent. Returns the row id (created or pre-existing/reactivated).
// `seedVirtualBalance` is used ONLY on first insert and MUST equal the
// user's current allocatedFunds (enforced by the caller). If the row
// already exists we never overwrite its virtualBalance from this helper —
// admin uses /refresh-shell for that corrective path.
async function attachUserToSharedMasterInTx(
  tx: Tx,
  userId: number,
  sharedMasterAccountId: number,
  seedVirtualBalance: number,
  accountType: "demo" | "live" = "demo",
): Promise<{ id: number; created: boolean; reactivated: boolean; row: typeof virtualTradingAccountsTable.$inferSelect }> {
  // Deterministic targeting: scope to the (userId, sharedMasterAccountId,
  // accountType) triple — which has a unique index — so we never touch
  // the user's demo row when operating on live (or vice versa).
  const existing = await tx.select().from(virtualTradingAccountsTable).where(and(
    eq(virtualTradingAccountsTable.userId, userId),
    eq(virtualTradingAccountsTable.sharedMasterAccountId, sharedMasterAccountId),
    eq(virtualTradingAccountsTable.accountType, accountType),
  )).for("update").limit(1);
  if (existing[0]) {
    if (existing[0].status.toLowerCase() !== "active") {
      const [updated] = await tx.update(virtualTradingAccountsTable)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(virtualTradingAccountsTable.id, existing[0].id))
        .returning();
      return { id: updated!.id, created: false, reactivated: true, row: updated! };
    }
    return { id: existing[0].id, created: false, reactivated: false, row: existing[0] };
  }
  const seed = round2(Math.max(0, seedVirtualBalance));
  const [created] = await tx.insert(virtualTradingAccountsTable).values({
    userId,
    routingMode: "SHARED_MASTER_MT5",
    sharedMasterAccountId,
    accountType,
    virtualBalance: seed,
    virtualEquity: seed,
    virtualMarginUsed: 0,
    virtualPnl: 0,
    status: "active",
  }).returning();
  return { id: created!.id, created: true, reactivated: false, row: created! };
}

// Adjust the user's SHARED_MASTER virtual account by `delta` (USD).
// No-op when the user has no active virtual account yet (admin has not
// attached them, or row is closed). virtualPnl is NEVER touched here —
// only by virtualPnlSync from closed trades.
//
// Targeting: scoped to the user's active SHARED_MASTER_MT5 shell. The
// `accountType` parameter is accepted for back-compat but no longer
// constrains the lookup — there is exactly one active shared master at
// a time (enforced by `arx_master_account_config`/`shared_master_accounts`
// `is_active`), so the user has at most one active SHARED_MASTER_MT5
// shell regardless of whether that master is demo or live. The previous
// `accountType='demo'`-only filter silently no-op'd for users attached
// to a live shared master and caused admin allocations to never sync
// the shell (T004). Ordered by id ASC for stable behaviour if legacy
// duplicates exist.
async function syncVirtualBalanceDeltaInTx(
  tx: Tx,
  userId: number,
  delta: number,
  _accountType: "demo" | "live" = "demo",
): Promise<{ updated: boolean; newBalance: number | null }> {
  void _accountType;
  if (!Number.isFinite(delta) || delta === 0) return { updated: false, newBalance: null };
  const rows = await tx.select().from(virtualTradingAccountsTable).where(and(
    eq(virtualTradingAccountsTable.userId, userId),
    vtaStatusActive(),
    eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
    isNotNull(virtualTradingAccountsTable.sharedMasterAccountId),
  )).orderBy(virtualTradingAccountsTable.id).for("update").limit(1);
  const row = rows[0];
  if (!row) return { updated: false, newBalance: null };
  const newBalance = round2(Number(row.virtualBalance) + delta);
  const newEquity = round2(Number(row.virtualEquity) + delta);
  const [updated] = await tx.update(virtualTradingAccountsTable).set({
    virtualBalance: newBalance,
    virtualEquity: newEquity,
    updatedAt: new Date(),
  }).where(eq(virtualTradingAccountsTable.id, row.id)).returning({ virtualBalance: virtualTradingAccountsTable.virtualBalance });
  return { updated: true, newBalance: Number(updated!.virtualBalance) };
}

// ── Automatic settled-only allocation reconciliation ───────────────────────
// When the real master balance drops so total allocations exceed the real
// backing (min(balance, equity)), automatically reduce allocations to fit —
// but NEVER pull from a user who has an OPEN live position. Open-trade users
// are protected; the system waits until their positions settle (close) before
// touching them ("never pull from users with open trades; always wait for the
// bridge to settle and then adjust"). This only ever REDUCES, never increases,
// and is fully audited (actor = SYSTEM). It is a safe no-op fast path whenever
// allocations are already within the real cap. Disable with the kill-switch env
// ARX_AUTO_REDUCE_ALLOCATIONS_DISABLED="true".
//
// Called fire-and-forget from the EA account/position sync handlers (the same
// places that recompute the pool). It NEVER places, modifies, or closes a
// trade, never touches any of the 16 Phase B gates, and never reads/writes one
// user's positions into another's allocation.
export type AutoReconcileResult = {
  adjusted: boolean;
  reason:
    | "DISABLED" | "MASTER_NOT_CONFIGURED" | "MASTER_STALE_WAITING"
    | "WITHIN_CAP" | "NO_SETTLED_HEADROOM" | "REDUCED";
  masterCap?: number;
  totalAllocated?: number;
  overage?: number;
  reducedBy?: number;
  protectedOpenUsers?: number;
  changes?: Array<{ userId: number; previous: number; newTotal: number }>;
};

export async function autoReconcileSettledAllocations(): Promise<AutoReconcileResult> {
  if ((process.env.ARX_AUTO_REDUCE_ALLOCATIONS_DISABLED ?? "").trim().toLowerCase() === "true") {
    return { adjusted: false, reason: "DISABLED" };
  }

  // Healthy-path fast skip (no locks). This runs fire-and-forget after every
  // EA heartbeat/sync (~15s), so the common case MUST stay cheap. The pool
  // snapshot is recomputed immediately before each call, so when it does not
  // flag over-allocation there is nothing to reduce and we return without
  // opening a tx / taking the advisory + row locks. The authoritative,
  // locked check still re-verifies inside the tx below for the over-allocated
  // case, so this is a pure no-op optimization with no TOCTOU risk (a missed
  // edge re-evaluates on the next heartbeat).
  const overFlagged = await db.select({ id: arxMasterBridgePoolTable.id })
    .from(arxMasterBridgePoolTable)
    .where(eq(arxMasterBridgePoolTable.isOverAllocated, true))
    .limit(1);
  if (overFlagged.length === 0) {
    return { adjusted: false, reason: "WITHIN_CAP" };
  }

  const outcome = await db.transaction(async (tx): Promise<AutoReconcileResult> => {
    const master = await loadMasterContextInTxForUpdate(tx);
    if (!master.configured || !master.hasRealBalance) {
      return { adjusted: false, reason: "MASTER_NOT_CONFIGURED" };
    }
    // "Always wait for the bridge to settle" — never adjust off a stale
    // snapshot. A stale heartbeat means we cannot trust the reported balance.
    if (master.isStale) {
      return { adjusted: false, reason: "MASTER_STALE_WAITING" };
    }
    // Strict Real-Balance Mode: the real backing is min(balance, equity).
    const masterCap = round2(Math.min(master.balance, master.equity));

    // Lock all allocation rows ascending — deterministic order matching the
    // single-row lock order used by the manual mutators, so the two paths
    // cannot deadlock against each other.
    const rows = await tx.select().from(userSlotAllocationTable)
      .orderBy(userSlotAllocationTable.id).for("update");
    const totalAllocated = round2(rows.reduce((s, r) => s + Number(r.allocatedFunds ?? 0), 0));
    if (totalAllocated <= masterCap) {
      return { adjusted: false, reason: "WITHIN_CAP", masterCap, totalAllocated };
    }
    const overage = round2(totalAllocated - masterCap);

    // Users with OPEN live exposure are protected and never reduced. Single
    // grouped read inside the tx for a snapshot consistent with the locked rows.
    const openRows = await tx.select({
      userId: arxLivePositionsTable.userId,
      cnt: sql<number>`count(*)::int`,
    }).from(arxLivePositionsTable)
      // Shared open-exposure truth — a reconciled/closed ghost must NOT keep a
      // user flagged as having open exposure (it would wrongly protect them
      // from allocation reduction).
      .where(openLiveExposureCondition())
      .groupBy(arxLivePositionsTable.userId);
    const openUserIds = new Set(openRows.map((r) => r.userId));

    // Settled = positive allocation AND no open positions.
    const settled = rows.filter((r) => Number(r.allocatedFunds ?? 0) > 0 && !openUserIds.has(r.userId));
    const settledTotal = round2(settled.reduce((s, r) => s + Number(r.allocatedFunds ?? 0), 0));
    const protectedOpenUsers = rows.filter(
      (r) => Number(r.allocatedFunds ?? 0) > 0 && openUserIds.has(r.userId),
    ).length;

    const reducible = round2(Math.min(overage, settledTotal));
    if (reducible <= 0) {
      // Every dollar of the overage is held by users with open trades. Wait for
      // them to settle; do NOT touch them. The pool stays honestly
      // over-allocated (the dispatch pre-gate keeps blocking) until they close.
      return { adjusted: false, reason: "NO_SETTLED_HEADROOM", masterCap, totalAllocated, overage, protectedOpenUsers };
    }

    // Plan the per-user reduction. Proportional first, then a deterministic
    // residual-cent pass so the TOTAL reduction equals `reducible` exactly —
    // otherwise per-row round2() drift can leave the pool a few cents over cap
    // (or, in small-balance states, round every row to unchanged and report
    // REDUCED while nothing actually moved). Residual is settled on the
    // largest-allocation rows first (stable by id), never pushing a row below 0.
    const plan = settled.map((r) => {
      const prev = round2(Number(r.allocatedFunds ?? 0));
      const share = settledTotal > 0 ? round2(reducible * (prev / settledTotal)) : 0;
      return { r, prev, reduce: Math.min(prev, share) };
    });
    let residual = round2(reducible - plan.reduce((s, p) => s + p.reduce, 0));
    if (residual !== 0) {
      const ordered = [...plan].sort((a, b) => b.prev - a.prev || a.r.id - b.r.id);
      for (const p of ordered) {
        if (round2(residual) === 0) break;
        if (residual > 0) {
          // Need to reduce more: take from this row's remaining headroom.
          const room = round2(p.prev - p.reduce);
          const take = Math.min(room, residual);
          p.reduce = round2(p.reduce + take);
          residual = round2(residual - take);
        } else {
          // Over-reduced: give cents back to this row.
          const give = Math.min(p.reduce, -residual);
          p.reduce = round2(p.reduce - give);
          residual = round2(residual + give);
        }
      }
    }

    const changes: Array<{ userId: number; previous: number; newTotal: number }> = [];

    for (const p of plan) {
      const r = p.r;
      const prev = p.prev;
      const newTotal = round2(prev - p.reduce);
      if (newTotal === prev) continue;
      const baseManual = Number(r.manualAllocatedFunds ?? 0);
      const baseAi = Number(r.aiAllocatedFunds ?? 0);
      const baseSum = baseManual + baseAi;
      const newManual = baseSum > 0 ? round2(newTotal * (baseManual / baseSum)) : newTotal;
      const newAi = round2(Math.max(0, newTotal - newManual));
      await tx.update(userSlotAllocationTable).set({
        allocatedFunds: newTotal,
        manualAllocatedFunds: newManual,
        aiAllocatedFunds: newAi,
        updatedAt: new Date(),
      }).where(eq(userSlotAllocationTable.id, r.id));
      const delta = round2(newTotal - prev); // < 0
      const shellSync = await syncVirtualBalanceDeltaInTx(tx, r.userId, delta);
      // Per-user audit row. Actor = SYSTEM (admin_id null) — this is an
      // automated, evidence-driven reduction, not an operator action.
      await tx.insert(adminActionAuditLogTable).values({
        adminId: null,
        adminRole: "SYSTEM",
        action: "AUTO_ALLOCATION_REDUCED_SETTLED",
        targetUserId: r.userId,
        beforeState: { allocatedFunds: prev, manualAllocatedFunds: baseManual, aiAllocatedFunds: baseAi },
        afterState: {
          allocatedFunds: newTotal, manualAllocatedFunds: newManual, aiAllocatedFunds: newAi,
          delta, virtualBalanceSynced: shellSync.updated,
        },
        reason: `Auto-reduce settled allocation: master real backing $${masterCap} < total allocated $${totalAllocated} (overage $${overage}). User has no open live positions; reduced proportionally among settled users. Open-trade users left untouched until they settle.`,
      });
      changes.push({ userId: r.userId, previous: prev, newTotal });
    }

    const adjusted = changes.length > 0;
    return {
      adjusted,
      // Keep reason and adjusted in lockstep: only claim REDUCED when rows
      // actually moved. If the residual pass still produced no change (e.g.
      // a sub-cent overage), report the honest no-headroom-applied state.
      reason: adjusted ? "REDUCED" : "NO_SETTLED_HEADROOM",
      masterCap, totalAllocated, overage,
      reducedBy: adjusted ? round2(changes.reduce((s, c) => s + (c.previous - c.newTotal), 0)) : 0,
      protectedOpenUsers, changes,
    };
  });

  if (outcome.adjusted) {
    // Re-project the pool so is_over_allocated/availableFunds reflect the
    // post-reduction reality immediately.
    await recomputeMasterPool();
  }
  return outcome;
}

// ── POST /api/admin/allocations/:userId/add ────────────────────────────────
const AmountBody = z.object({
  amount: z.number().positive(),
  note: z.string().max(500).optional(),
  // bridgeConnectionId is accepted for back-compat with the frontend but
  // ignored — there is exactly one active master config and all slot
  // allocations route through it.
  bridgeConnectionId: z.number().int().optional(),
});

router.post("/admin/allocations/:userId/add", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = AmountBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY", issues: parsed.error.issues }); return; }
  const { amount, note } = parsed.data;

  // Task #1 — pre-check the master pool snapshot OUTSIDE the tx so we
  // can refuse with the new typed reasons before holding any locks.
  const pre = await precheckMasterPoolForAllocation();
  if (!pre.ok) { res.status(pre.status).json(pre.body); return; }

  const result = await db.transaction(async (tx) => {
    const master = await loadMasterContextInTxForUpdate(tx);
    if (!master.configured) return fail(409, { ok: false, error: "MASTER_NOT_CONFIGURED",
      message: "No active master account is configured." });
    if (master.isStale) return fail(409, { ok: false, error: "MASTER_BRIDGE_STALE",
      message: "Master MT5 heartbeat is stale. Wait for a fresh snapshot before adding allocation." });

    const currentlyAllocated = await sumAllocatedInTx(tx);
    // Task #1 — Strict Real-Balance Mode: cap = min(balance, equity).
    // Using min() is conservative: if equity has dropped below balance
    // (floating losses), the master cannot fund the larger figure.
    const masterCap = Math.min(master.balance, master.equity);
    if (currentlyAllocated + amount > masterCap) {
      return fail(409, {
        // Surface BOTH the legacy and the Task #1 typed reasons so the
        // new admin UI can match on ALLOCATION_EXCEEDS_MASTER_AVAILABLE
        // while existing tests pinned to EXCEEDS_MASTER_CAPACITY still
        // pass.
        ok: false,
        error: "ALLOCATION_EXCEEDS_MASTER_AVAILABLE",
        legacyError: "EXCEEDS_MASTER_CAPACITY",
        message: `Add would exceed master available (min of balance/equity). Available headroom: $${round2(masterCap - currentlyAllocated).toFixed(2)}.`,
        headroom: round2(masterCap - currentlyAllocated),
        masterBalance: round2(master.balance),
        masterEquity: round2(master.equity),
        masterCap: round2(masterCap),
      });
    }

    let before = await loadAllocInTx(tx, userId);
    if (!before) before = await seedAllocInTx(tx, userId, admin.id);
    const base = normalizeSplit(before);
    const newTotal = round2(base.total + amount);
    const newManual = round2(base.manual + amount);
    const newAi = round2(base.ai);

    const [after] = await tx.update(userSlotAllocationTable).set({
      allocatedFunds: newTotal,
      manualAllocatedFunds: newManual,
      aiAllocatedFunds: newAi,
      isActive: true,
      updatedAt: new Date(),
    }).where(eq(userSlotAllocationTable.id, before.id)).returning();

    // Sync uses the PERSISTED delta (newTotal - base.total), not the raw
    // request `amount`. After round2 the two normally match, but routing
    // through the persisted value guarantees the shell can never drift
    // from user_slot_allocation by sub-cent rounding when a non-2dp
    // input slips past Zod (e.g. 1.005).
    const persistedDelta = round2(newTotal - base.total);
    const shellSync = await syncVirtualBalanceDeltaInTx(tx, userId, persistedDelta);
    await auditInTx(tx, {
      admin, action: "ALLOCATION_ADD", targetUserId: userId,
      beforeState: { allocatedFunds: base.total, manualAllocatedFunds: base.manual, aiAllocatedFunds: base.ai },
      afterState: { allocatedFunds: newTotal, manualAllocatedFunds: newManual, aiAllocatedFunds: newAi, delta: persistedDelta, virtualBalanceSynced: shellSync.updated, newVirtualBalance: shellSync.newBalance },
      reason: note ?? null, ipAddress: ipOf(req),
    });
    return { ok: true as const, previous: base.total, added: amount, newTotal, alloc: after, virtualBalanceSynced: shellSync.updated, newVirtualBalance: shellSync.newBalance };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_ADD", userId, note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/remove ─────────────────────────────
router.post("/admin/allocations/:userId/remove", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = AmountBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { amount, note } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const before = await loadAllocInTx(tx, userId);
    if (!before) return fail(404, { ok: false, error: "NO_ALLOCATION",
      message: "User has no allocation to remove from." });
    const base = normalizeSplit(before);
    // PnL pulled from EA-driven position tables — admin allocation
    // mutations cannot move it, so a same-tx read is sufficient as a
    // conservative best-effort exposure check.
    const pnl = await getUserPnl(userId);
    const slotBalance = base.total + pnl.realisedPnl;
    if (amount > slotBalance && pnl.openCount > 0) {
      return fail(409, {
        ok: false, error: "OPEN_EXPOSURE_BLOCKS_REMOVAL",
        message: "User has open positions. Close or reduce exposure before removing this much allocation.",
        openCount: pnl.openCount, slotBalance: round2(slotBalance),
      });
    }
    const newTotal = round2(Math.max(0, base.total - amount));
    const removedFromManual = Math.min(amount, base.manual);
    const removedFromAi = Math.max(0, amount - removedFromManual);
    const newManual = round2(Math.max(0, base.manual - removedFromManual));
    const newAi = round2(Math.max(0, base.ai - removedFromAi));

    const [after] = await tx.update(userSlotAllocationTable).set({
      allocatedFunds: newTotal,
      manualAllocatedFunds: newManual,
      aiAllocatedFunds: newAi,
      updatedAt: new Date(),
    }).where(eq(userSlotAllocationTable.id, before.id)).returning();

    const removedDelta = newTotal - base.total; // negative or zero
    const shellSync = await syncVirtualBalanceDeltaInTx(tx, userId, removedDelta);
    await auditInTx(tx, {
      admin, action: "ALLOCATION_REMOVE", targetUserId: userId,
      beforeState: { allocatedFunds: base.total, manualAllocatedFunds: base.manual, aiAllocatedFunds: base.ai },
      afterState: { allocatedFunds: newTotal, manualAllocatedFunds: newManual, aiAllocatedFunds: newAi, delta: removedDelta, virtualBalanceSynced: shellSync.updated, newVirtualBalance: shellSync.newBalance },
      reason: note ?? null, ipAddress: ipOf(req),
    });
    return { ok: true as const, previous: base.total, removed: amount, newTotal, alloc: after, virtualBalanceSynced: shellSync.updated, newVirtualBalance: shellSync.newBalance };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_REMOVE", userId, note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/set ────────────────────────────────
const SetBody = z.object({
  amount: z.number().min(0),
  note: z.string().max(500).optional(),
  bridgeConnectionId: z.number().int().optional(),
});

router.post("/admin/allocations/:userId/set", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = SetBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { amount, note } = parsed.data;

  // Task #1 — pre-check master pool only when the operation is an
  // INCREASE (delta>0). Decreases never need a healthy pool to proceed.
  // We resolve the delta after loading existing allocation, then gate.

  const result = await db.transaction(async (tx) => {
    const master = await loadMasterContextInTxForUpdate(tx);
    let before = await loadAllocInTx(tx, userId);
    const baseTotal = before ? normalizeSplit(before).total : 0;
    // Persist the rounded form so capacity/cap math and the shell sync
    // both derive from the same authoritative number, never the raw
    // request `amount` which could carry sub-cent noise.
    const persistedAmount = round2(amount);
    const delta = round2(persistedAmount - baseTotal);

    if (delta > 0) {
      // Task #1 — strict master-pool precheck parity with /add.
      // Surfaces typed reasons: MASTER_BRIDGE_NOT_PINNED, SHARED_LIVE_PAUSED,
      // MASTER_SNAPSHOT_MISSING, MASTER_SNAPSHOT_STALE before falling through
      // to the legacy capacity check.
      const poolPre = await precheckMasterPoolForAllocation();
      if (!poolPre.ok) {
        return fail(poolPre.status, poolPre.body);
      }
      if (!master.configured) return fail(409, { ok: false, error: "MASTER_NOT_CONFIGURED" });
      if (master.isStale) return fail(409, { ok: false, error: "MASTER_BRIDGE_STALE",
        message: "Master heartbeat stale; cannot increase allocation." });
      const currentlyAllocated = await sumAllocatedInTx(tx);
      // Task #1 — Strict Real-Balance Mode: cap = min(balance, equity).
      const masterCap = Math.min(master.balance, master.equity);
      if (currentlyAllocated + delta > masterCap) {
        return fail(409, { ok: false,
          error: "ALLOCATION_EXCEEDS_MASTER_AVAILABLE",
          legacyError: "EXCEEDS_MASTER_CAPACITY",
          headroom: round2(masterCap - currentlyAllocated),
          masterBalance: round2(master.balance),
          masterEquity: round2(master.equity),
          masterCap: round2(masterCap) });
      }
    }

    if (!before) before = await seedAllocInTx(tx, userId, admin.id);
    const base = normalizeSplit(before);
    let newManual = round2(Math.max(0, base.manual + delta));
    let newAi = round2(base.ai);
    if (newManual + newAi > persistedAmount) {
      const overflow = newManual + newAi - persistedAmount;
      newManual = round2(Math.max(0, newManual - overflow));
      if (newManual + newAi > persistedAmount) newAi = round2(Math.max(0, persistedAmount - newManual));
    }

    const [after] = await tx.update(userSlotAllocationTable).set({
      allocatedFunds: persistedAmount,
      manualAllocatedFunds: newManual,
      aiAllocatedFunds: newAi,
      isActive: true,
      updatedAt: new Date(),
    }).where(eq(userSlotAllocationTable.id, before.id)).returning();

    const shellSync = await syncVirtualBalanceDeltaInTx(tx, userId, delta);
    await auditInTx(tx, {
      admin, action: "ALLOCATION_SET", targetUserId: userId,
      beforeState: { allocatedFunds: base.total, manualAllocatedFunds: base.manual, aiAllocatedFunds: base.ai },
      afterState: { allocatedFunds: persistedAmount, manualAllocatedFunds: newManual, aiAllocatedFunds: newAi, delta, virtualBalanceSynced: shellSync.updated, newVirtualBalance: shellSync.newBalance },
      reason: note ?? null, ipAddress: ipOf(req),
    });
    return { ok: true as const, previous: base.total, newTotal: round2(amount), alloc: after, virtualBalanceSynced: shellSync.updated, newVirtualBalance: shellSync.newBalance };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_SET", userId, note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/transfer ───────────────────────────
const TransferBody = z.object({
  toUserId: z.number().int().positive(),
  amount: z.number().positive(),
  note: z.string().max(500).optional(),
  bridgeConnectionId: z.number().int().optional(),
});

router.post("/admin/allocations/:userId/transfer", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const fromUserId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(fromUserId) || fromUserId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = TransferBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { toUserId, amount, note } = parsed.data;
  if (toUserId === fromUserId) { res.status(400).json({ ok: false, error: "SELF_TRANSFER_NOT_ALLOWED" }); return; }

  const result = await db.transaction(async (tx) => {
    // Serialise against every other allocation mutator (incl. the SYSTEM
    // auto-reconcile, which locks all rows in id order) so the two-row lock
    // below can never deadlock with a different lock ordering.
    await acquireAllocationSerializationLock(tx);
    // Lock both rows in ascending userId order (see loadTwoAllocsForUpdate)
    // so an opposite-direction transfer cannot deadlock.
    const both = await loadTwoAllocsForUpdate(tx, fromUserId, toUserId);
    let from = both.a;
    let to = both.b;
    if (!from) return fail(404, { ok: false, error: "SOURCE_HAS_NO_ALLOCATION" });
    const fromBase = normalizeSplit(from);
    const fromPnl = await getUserPnl(fromUserId);
    const fromAvailable = fromBase.total + fromPnl.realisedPnl;
    if (amount > fromAvailable || (fromPnl.openCount > 0 && amount > fromBase.total)) {
      return fail(409, { ok: false, error: "INSUFFICIENT_AVAILABLE",
        message: "Source user does not have enough unreserved allocation to transfer.",
        fromAvailable: round2(fromAvailable), openCount: fromPnl.openCount });
    }

    if (!to) to = await seedAllocInTx(tx, toUserId, admin.id);
    const toBase = normalizeSplit(to);

    const fromNewTotal = round2(Math.max(0, fromBase.total - amount));
    const fromManualReduce = Math.min(amount, fromBase.manual);
    const fromAiReduce = Math.max(0, amount - fromManualReduce);
    const fromNewManual = round2(Math.max(0, fromBase.manual - fromManualReduce));
    const fromNewAi = round2(Math.max(0, fromBase.ai - fromAiReduce));
    const toNewTotal = round2(toBase.total + amount);
    const toNewManual = round2(toBase.manual + amount);

    await tx.update(userSlotAllocationTable).set({
      allocatedFunds: fromNewTotal,
      manualAllocatedFunds: fromNewManual,
      aiAllocatedFunds: fromNewAi,
      updatedAt: new Date(),
    }).where(eq(userSlotAllocationTable.id, from.id));
    await tx.update(userSlotAllocationTable).set({
      allocatedFunds: toNewTotal,
      manualAllocatedFunds: toNewManual,
      isActive: true,
      updatedAt: new Date(),
    }).where(eq(userSlotAllocationTable.id, to.id));

    // Use the EXACT persisted deltas (not raw `amount`) so the virtual
    // shell stays in lockstep with user_slot_allocation when fromNewTotal
    // got clamped to 0 by Math.max above.
    const fromDelta = round2(fromNewTotal - fromBase.total);
    const toDelta = round2(toNewTotal - toBase.total);
    const fromSync = await syncVirtualBalanceDeltaInTx(tx, fromUserId, fromDelta);
    const toSync = await syncVirtualBalanceDeltaInTx(tx, toUserId, toDelta);
    await auditInTx(tx, {
      admin, action: "ALLOCATION_TRANSFER_OUT", targetUserId: fromUserId,
      beforeState: { allocatedFunds: fromBase.total, manualAllocatedFunds: fromBase.manual, aiAllocatedFunds: fromBase.ai },
      afterState: { allocatedFunds: fromNewTotal, transferredTo: toUserId, amount, virtualBalanceSynced: fromSync.updated, newVirtualBalance: fromSync.newBalance },
      reason: note ?? null, ipAddress: ipOf(req),
    });
    await auditInTx(tx, {
      admin, action: "ALLOCATION_TRANSFER_IN", targetUserId: toUserId,
      beforeState: { allocatedFunds: toBase.total, manualAllocatedFunds: toBase.manual, aiAllocatedFunds: toBase.ai },
      afterState: { allocatedFunds: toNewTotal, transferredFrom: fromUserId, amount, virtualBalanceSynced: toSync.updated, newVirtualBalance: toSync.newBalance },
      reason: note ?? null, ipAddress: ipOf(req),
    });
    return { ok: true as const,
      from: { userId: fromUserId, previous: fromBase.total, new: fromNewTotal },
      to:   { userId: toUserId,   previous: toBase.total,   new: toNewTotal },
      amount };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_TRANSFER", fromUserId, note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/freeze ─────────────────────────────
const FreezeBody = z.object({
  freezeType: z.enum(["full", "trading", "ai"]),
  reason: z.string().min(1).max(500),
  bridgeConnectionId: z.number().int().optional(),
});

router.post("/admin/allocations/:userId/freeze", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = FreezeBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { freezeType, reason } = parsed.data;

  await db.transaction(async (tx) => {
    let before = await loadAllocInTx(tx, userId);
    if (!before) before = await seedAllocInTx(tx, userId, admin.id);
    const patch: Partial<typeof userSlotAllocationTable.$inferInsert> = {
      freezeReason: reason,
      frozenAt: new Date(),
      frozenByUserId: admin.id,
      updatedAt: new Date(),
    };
    if (freezeType === "full") { patch.allocationStatus = "frozen"; patch.tradingFrozen = true; patch.aiTradingFrozen = true; }
    else if (freezeType === "trading") { patch.tradingFrozen = true; }
    else if (freezeType === "ai") { patch.aiTradingFrozen = true; }

    await tx.update(userSlotAllocationTable).set(patch).where(eq(userSlotAllocationTable.id, before.id));
    await auditInTx(tx, {
      admin, action: `ALLOCATION_FREEZE_${freezeType.toUpperCase()}`, targetUserId: userId,
      beforeState: { allocationStatus: before.allocationStatus, tradingFrozen: before.tradingFrozen, aiTradingFrozen: before.aiTradingFrozen },
      afterState: { freezeType, ...patch },
      reason, ipAddress: ipOf(req),
    });
  });

  await mirrorAllocationChange(admin, `ALLOCATION_FREEZE_${freezeType.toUpperCase()}`, userId, reason);
  res.json({ ok: true, freezeType, frozen: true, reason });
});

// ── POST /api/admin/allocations/:userId/unfreeze ───────────────────────────
const UnfreezeBody = z.object({
  unfreezeType: z.enum(["full", "trading", "ai"]),
  note: z.string().max(500).optional(),
  bridgeConnectionId: z.number().int().optional(),
});

router.post("/admin/allocations/:userId/unfreeze", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = UnfreezeBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { unfreezeType, note } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const before = await loadAllocInTx(tx, userId);
    if (!before) return fail(404, { ok: false, error: "NO_ALLOCATION",
      message: "User has no allocation row to unfreeze." });
    const patch: Partial<typeof userSlotAllocationTable.$inferInsert> = { updatedAt: new Date() };
    if (unfreezeType === "full") {
      patch.allocationStatus = "active";
      patch.tradingFrozen = false; patch.aiTradingFrozen = false; patch.closeOnlyMode = false;
      patch.freezeReason = null; patch.frozenAt = null; patch.frozenByUserId = null;
    } else if (unfreezeType === "trading") {
      patch.tradingFrozen = false;
      if (!before.aiTradingFrozen) { patch.allocationStatus = "active"; patch.freezeReason = null; patch.frozenAt = null; patch.frozenByUserId = null; }
    } else if (unfreezeType === "ai") {
      patch.aiTradingFrozen = false;
      if (!before.tradingFrozen) { patch.allocationStatus = "active"; patch.freezeReason = null; patch.frozenAt = null; patch.frozenByUserId = null; }
    }

    await tx.update(userSlotAllocationTable).set(patch).where(eq(userSlotAllocationTable.id, before.id));
    await auditInTx(tx, {
      admin, action: `ALLOCATION_UNFREEZE_${unfreezeType.toUpperCase()}`, targetUserId: userId,
      beforeState: { allocationStatus: before.allocationStatus, tradingFrozen: before.tradingFrozen, aiTradingFrozen: before.aiTradingFrozen, freezeReason: before.freezeReason },
      afterState: { unfreezeType, ...patch },
      reason: note ?? null, ipAddress: ipOf(req),
    });
    return { ok: true as const };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, `ALLOCATION_UNFREEZE_${unfreezeType.toUpperCase()}`, userId, note ?? null);
  res.json({ ok: true, unfreezeType, frozen: false });
});

// ── POST /api/admin/allocations/:userId/ai ─────────────────────────────────
const AiBody = z.object({
  aiAmount: z.number().min(0).optional(),
  aiAutoTradingEnabled: z.boolean().optional(),
  aiWatchOnly: z.boolean().optional(),
  aiStrategyMode: z.enum(["watch_only", "conservative", "balanced", "aggressive"]).optional(),
  aiMaxLot: z.number().positive().nullable().optional(),
  aiMaxDailyLoss: z.number().positive().nullable().optional(),
  note: z.string().max(500).optional(),
  bridgeConnectionId: z.number().int().optional(),
});

router.post("/admin/allocations/:userId/ai", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = AiBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const body = parsed.data;

  const result = await db.transaction(async (tx) => {
    let before = await loadAllocInTx(tx, userId);
    if (!before) {
      if (body.aiAmount !== undefined && body.aiAmount > 0) {
        return fail(409, { ok: false, error: "AI_EXCEEDS_TOTAL",
          message: "User has no allocation; cannot fund AI sleeve." });
      }
      before = await seedAllocInTx(tx, userId, admin.id);
    }
    const base = normalizeSplit(before);
    const patch: Partial<typeof userSlotAllocationTable.$inferInsert> = { updatedAt: new Date() };

    if (body.aiAmount !== undefined) {
      if (body.aiAmount > base.total) {
        return fail(409, { ok: false, error: "AI_EXCEEDS_TOTAL",
          message: "AI sleeve cannot exceed the user's total allocation." });
      }
      const delta = body.aiAmount - base.ai;
      const newManual = round2(Math.max(0, base.manual - delta));
      patch.aiAllocatedFunds = round2(body.aiAmount);
      patch.manualAllocatedFunds = newManual;
    } else {
      // Pure config change — still normalize the split persistence so the
      // pre-split row is migrated to the explicit manual bucket.
      if (base.manual !== Number(before.manualAllocatedFunds) || base.ai !== Number(before.aiAllocatedFunds)) {
        patch.manualAllocatedFunds = round2(base.manual);
        patch.aiAllocatedFunds = round2(base.ai);
      }
    }
    if (body.aiAutoTradingEnabled !== undefined) patch.aiAutoTradingEnabled = body.aiAutoTradingEnabled;
    if (body.aiStrategyMode !== undefined) patch.aiStrategyMode = body.aiStrategyMode;
    else if (body.aiWatchOnly === true) patch.aiStrategyMode = "watch_only";
    if (body.aiMaxLot !== undefined) patch.aiMaxLot = body.aiMaxLot ?? null;
    if (body.aiMaxDailyLoss !== undefined) patch.aiMaxDailyLossUsd = body.aiMaxDailyLoss ?? null;

    await tx.update(userSlotAllocationTable).set(patch).where(eq(userSlotAllocationTable.id, before.id));
    await auditInTx(tx, {
      admin, action: body.aiAmount !== undefined ? "ALLOCATION_AI_SET" : "ALLOCATION_AI_CONFIG",
      targetUserId: userId,
      beforeState: {
        aiAllocatedFunds: before.aiAllocatedFunds,
        manualAllocatedFunds: before.manualAllocatedFunds,
        aiAutoTradingEnabled: before.aiAutoTradingEnabled,
        aiStrategyMode: before.aiStrategyMode,
        aiMaxLot: before.aiMaxLot,
        aiMaxDailyLossUsd: before.aiMaxDailyLossUsd,
      },
      afterState: patch as Record<string, unknown>,
      reason: body.note ?? null, ipAddress: ipOf(req),
    });
    return { ok: true as const };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, body.aiAmount !== undefined ? "ALLOCATION_AI_SET" : "ALLOCATION_AI_CONFIG", userId, body.note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/attach-shared-master ───────────────
// Attaches the user to the active master MT5 (SHARED_MASTER_MT5 routing) by
// creating their virtual_trading_accounts row. Idempotent. Optionally seeds
// virtualBalance from the user's current allocatedFunds (default) or an
// explicit `startingBalance`. Auto-seeds an empty user_slot_allocation row
// when missing so the user appears in the admin table. Never inserts into
// arx_live_commands and never modifies any of the 16 Phase B gates.
// Note: no `startingBalance` field. The seed is always the user's current
// `allocatedFunds` so the shell strictly reflects what admin allocated.
// To change the shell after attach, use /add, /set, or /refresh-shell.
// ── Shared attach flow ───────────────────────────────────────────────────
// The exact in-transaction provisioning the admin attach route performs,
// factored out so the master-live approve handler and the back-fill script
// can reuse it WITHOUT duplicating any of the safety/audit code. This is
// pure visibility scaffolding: it find-or-creates the user's
// SHARED_MASTER_MT5 virtual_trading_accounts row (seeding an empty
// user_slot_allocation row when missing) and audits the action. It NEVER
// arms the user for live execution, NEVER inserts into arx_live_commands,
// and NEVER touches any of the Phase B gates — execution still requires
// the user to manually arm + every gate to PASS. Idempotent: a second call
// re-uses (or reactivates) the existing row. Returns a TxFailure sentinel
// (mapped to an HTTP status by route callers) on a missing user or an
// unconfigured master so the caller decides how to surface it.
export type AttachSharedMasterFlowResult =
  | {
      ok: true;
      attached: true;
      created: boolean;
      reactivated: boolean;
      virtualAccountId: number;
      sharedMasterAccountId: number;
      virtualBalance: number;
      allocatedFunds: number;
    }
  | TxFailure;

export async function attachUserToSharedMasterInTxFlow(
  tx: Tx,
  actor: { id: number; role: "ADMIN" | "OWNER" },
  userId: number,
  acctType: "demo" | "live",
  note: string | null,
  ipAddress: string | null,
): Promise<AttachSharedMasterFlowResult> {
  // Validate target user exists. FOR UPDATE serialises concurrent
  // actions against the same user (attach/detach/refresh races).
  const userRow = await tx.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.id, userId)).for("update").limit(1);
  if (!userRow[0]) return fail(404, { ok: false, error: "USER_NOT_FOUND" });

  const master = await loadMasterContextInTxForUpdate(tx);
  if (!master.configured || master.masterConnectionId == null) {
    return fail(409, { ok: false, error: "MASTER_NOT_CONFIGURED",
      message: "No active master MT5 bridge is configured. Pin or connect a master bridge before attaching users." });
  }

  const smaId = await ensureSharedMasterAccountInTx(tx, master.masterConnectionId, acctType);

  // Auto-seed an empty allocation row if missing so the user appears in
  // the admin table and the shell has a known principal target.
  let alloc = await loadAllocInTx(tx, userId);
  if (!alloc) alloc = await seedAllocInTx(tx, userId, actor.id);
  const allocTotal = Number(alloc.allocatedFunds);

  // Seed is always the persisted allocation — never a free-form input —
  // so the user-facing shell can only reflect honest allocated funds.
  const seed = round2(allocTotal);
  const attach = await attachUserToSharedMasterInTx(tx, userId, smaId, seed, acctType);

  await auditInTx(tx, {
    admin: actor, action: "ALLOCATION_ATTACH_SHARED_MASTER", targetUserId: userId,
    beforeState: { attached: !attach.created && !attach.reactivated, virtualAccountId: attach.created ? null : attach.id },
    afterState: {
      sharedMasterAccountId: smaId,
      masterConnectionId: master.masterConnectionId,
      virtualAccountId: attach.id,
      accountType: acctType,
      seedVirtualBalance: attach.created ? seed : null,
      created: attach.created,
      reactivated: attach.reactivated,
      allocatedFunds: allocTotal,
    },
    reason: note ?? null, ipAddress,
  });

  return { ok: true as const,
    attached: true,
    created: attach.created,
    reactivated: attach.reactivated,
    virtualAccountId: attach.id,
    sharedMasterAccountId: smaId,
    virtualBalance: Number(attach.row.virtualBalance),
    allocatedFunds: allocTotal,
  };
}

const AttachBody = z.object({
  accountType: z.enum(["demo", "live"]).optional(),
  note: z.string().max(500).optional(),
});
router.post("/admin/allocations/:userId/attach-shared-master", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = AttachBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY", issues: parsed.error.issues }); return; }
  const { accountType, note } = parsed.data;
  const acctType = accountType ?? "demo";

  const result = await db.transaction(async (tx) =>
    attachUserToSharedMasterInTxFlow(tx, admin, userId, acctType, note ?? null, ipOf(req)),
  );

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_ATTACH_SHARED_MASTER", userId, note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/detach-shared-master ───────────────
// Soft-detach: sets virtual_trading_accounts.status='closed'. Preserves the
// row so audit/attribution references stay intact. Refuses if the user has
// open positions on the master.
const DetachBody = z.object({ note: z.string().max(500).optional() });
router.post("/admin/allocations/:userId/detach-shared-master", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = DetachBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { note } = parsed.data;

  const result = await db.transaction(async (tx) => {
    // Lock the user row first so concurrent attach/detach/refresh on the
    // same user serialise. The live-position ingestion path itself does
    // not lock this row, but bridge inserts require Phase B PASS which
    // is independently gated; combining the user lock with a re-read of
    // open positions gives us a defensive race window of essentially the
    // bridge polling interval.
    const userRow = await tx.select({ id: usersTable.id })
      .from(usersTable).where(eq(usersTable.id, userId)).for("update").limit(1);
    if (!userRow[0]) return fail(404, { ok: false, error: "USER_NOT_FOUND" });

    // Demo-scoped: this admin route family operates on the user's demo
    // shell only. Any live virtual row a user might separately hold is
    // intentionally not touched here so a stray detach can never close
    // the wrong shell.
    const rows = await tx.select().from(virtualTradingAccountsTable).where(and(
      eq(virtualTradingAccountsTable.userId, userId),
      vtaStatusActive(),
      eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
      eq(virtualTradingAccountsTable.accountType, "demo"),
      isNotNull(virtualTradingAccountsTable.sharedMasterAccountId),
    )).orderBy(virtualTradingAccountsTable.id).for("update").limit(1);
    const row = rows[0];
    if (!row) return fail(404, { ok: false, error: "NOT_ATTACHED",
      message: "User is not currently attached to a shared master." });

    // Block detach when the user still has open live positions, to avoid
    // orphaning the ledger between EA fills and the virtual account. The
    // user-row FOR UPDATE above serialises this against any other admin
    // mutation that could insert a position via Phase B dispatch.
    const openCount = await tx.select({ id: arxLivePositionsTable.id })
      .from(arxLivePositionsTable)
      // Shared open-exposure truth — a reconciled ghost must not block detach.
      .where(openLiveExposureCondition(userId));
    if (openCount.length > 0) {
      return fail(409, { ok: false, error: "OPEN_POSITIONS_BLOCK_DETACH",
        message: "User has open live positions. Close them before detaching." });
    }

    await tx.update(virtualTradingAccountsTable).set({
      status: "closed", updatedAt: new Date(),
    }).where(eq(virtualTradingAccountsTable.id, row.id));

    await auditInTx(tx, {
      admin, action: "ALLOCATION_DETACH_SHARED_MASTER", targetUserId: userId,
      beforeState: { virtualAccountId: row.id, status: row.status, virtualBalance: Number(row.virtualBalance) },
      afterState:  { virtualAccountId: row.id, status: "closed" },
      reason: note ?? null, ipAddress: ipOf(req),
    });

    return { ok: true as const, virtualAccountId: row.id, status: "closed" };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_DETACH_SHARED_MASTER", userId, note ?? null);
  res.json(result);
});

// ── POST /api/admin/allocations/:userId/refresh-shell ──────────────────────
// Corrective: forces virtualBalance = allocatedFunds + virtualPnl, so the
// principal portion exactly matches the admin's allocated total. virtualPnl
// is preserved (set by virtualPnlSync from closed trades only).
const RefreshBody = z.object({ note: z.string().max(500).optional() });
router.post("/admin/allocations/:userId/refresh-shell", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = RefreshBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { note } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const userRow = await tx.select({ id: usersTable.id })
      .from(usersTable).where(eq(usersTable.id, userId)).for("update").limit(1);
    if (!userRow[0]) return fail(404, { ok: false, error: "USER_NOT_FOUND" });
    const alloc = await loadAllocInTx(tx, userId);
    if (!alloc) return fail(404, { ok: false, error: "NO_ALLOCATION" });
    // T004: Target the user's single active SHARED_MASTER_MT5 shell
    // regardless of accountType. Only one shared master is active at a
    // time, so each user has at most one matching row. Previous
    // `accountType='demo'`-only filter silently refused to repair shells
    // for users attached to a live shared master.
    const rows = await tx.select().from(virtualTradingAccountsTable).where(and(
      eq(virtualTradingAccountsTable.userId, userId),
      vtaStatusActive(),
      eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
      isNotNull(virtualTradingAccountsTable.sharedMasterAccountId),
    )).orderBy(virtualTradingAccountsTable.id).for("update").limit(1);
    const row = rows[0];
    if (!row) return fail(409, { ok: false, error: "NOT_ATTACHED",
      message: "User must be attached to a shared master before refreshing their shell." });

    const allocTotal = Number(alloc.allocatedFunds);
    const pnl = Number(row.virtualPnl);
    const newBalance = round2(allocTotal + pnl);
    const newEquity = newBalance; // best-effort; periodic sync recomputes from open positions.

    await tx.update(virtualTradingAccountsTable).set({
      virtualBalance: newBalance,
      virtualEquity: newEquity,
      updatedAt: new Date(),
    }).where(eq(virtualTradingAccountsTable.id, row.id));

    await auditInTx(tx, {
      admin, action: "ALLOCATION_REFRESH_SHELL", targetUserId: userId,
      beforeState: { virtualBalance: Number(row.virtualBalance), virtualEquity: Number(row.virtualEquity), virtualPnl: pnl },
      afterState:  { virtualBalance: newBalance, virtualEquity: newEquity, allocatedFunds: allocTotal },
      reason: note ?? null, ipAddress: ipOf(req),
    });

    return { ok: true as const,
      virtualAccountId: row.id,
      previousVirtualBalance: Number(row.virtualBalance),
      newVirtualBalance: newBalance,
      allocatedFunds: allocTotal,
      virtualPnl: pnl,
    };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await mirrorAllocationChange(admin, "ALLOCATION_REFRESH_SHELL", userId, note ?? null);
  res.json(result);
});

// ── GET /api/admin/allocations/users-eligible ──────────────────────────────
// Lists users who do NOT currently have an active SHARED_MASTER virtual
// account. Supports `q` (case-insensitive substring on email/name).
// Limited to 50 results. No sensitive fields returned.
router.get("/admin/allocations/users-eligible", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const q = String(req.query.q ?? "").trim();
  // Subquery: userIds with an active SHARED_MASTER virtual account.
  const attachedUserIds = (await db.select({ userId: virtualTradingAccountsTable.userId })
    .from(virtualTradingAccountsTable)
    .where(and(
      eq(virtualTradingAccountsTable.routingMode, "SHARED_MASTER_MT5"),
      vtaStatusActive(),
      isNotNull(virtualTradingAccountsTable.sharedMasterAccountId),
    ))).map((r) => r.userId);

  const conds = [] as Array<ReturnType<typeof and>>;
  if (attachedUserIds.length) {
    conds.push(sql`${usersTable.id} NOT IN (${sql.join(attachedUserIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (q) {
    const like = `%${q}%`;
    conds.push(or(ilike(usersTable.email, like), ilike(usersTable.name, like))!);
  }

  const baseQuery = db.select({
    id: usersTable.id,
    email: usersTable.email,
    name: usersTable.name,
    role: usersTable.role,
    allocatedFunds: userSlotAllocationTable.allocatedFunds,
  }).from(usersTable).leftJoin(
    userSlotAllocationTable, eq(userSlotAllocationTable.userId, usersTable.id),
  );

  const rows = conds.length
    ? await baseQuery.where(and(...conds.filter(Boolean) as Parameters<typeof and>)).orderBy(usersTable.email).limit(50)
    : await baseQuery.orderBy(usersTable.email).limit(50);

  res.json({
    ok: true,
    users: rows.map((r) => ({
      userId: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      allocatedFunds: r.allocatedFunds != null ? round2(Number(r.allocatedFunds)) : 0,
      attached: false,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task #1 — Shared bridge: MT5 is source of truth.
// New admin reconciliation endpoints. All admin-only, all audit-logged
// to admin_action_audit_log. None of these ever insert into
// arx_live_commands or modify any of the 16 Phase B dispatch gates.
// ─────────────────────────────────────────────────────────────────────────

// ── GET /api/admin/allocations/master-pool ─────────────────────────────────
// Returns the current pool snapshot. Recomputes first so the response
// is always FRESH at request time.
//
// Audit: writes an ALLOCATION_POOL_VIEWED row per admin call so that a
// post-mortem can reconstruct who looked at the master snapshot during
// an incident. Deduped to once per POOL_VIEW_AUDIT_DEDUP_MS per admin
// so the 5s admin-side poll doesn't spam the audit log. No per-user
// data is recorded — only admin id/role + timestamp (timestamp is the
// row's own `createdAt`).
const POOL_VIEW_AUDIT_DEDUP_MS = 30_000;
const lastPoolViewAuditAtByAdmin = new Map<number, number>();

router.get("/admin/allocations/master-pool", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const now = Date.now();
  const lastAt = lastPoolViewAuditAtByAdmin.get(admin.id) ?? 0;
  if (now - lastAt >= POOL_VIEW_AUDIT_DEDUP_MS) {
    lastPoolViewAuditAtByAdmin.set(admin.id, now);
    try {
      await audit({
        admin,
        action: "ALLOCATION_POOL_VIEWED",
        targetUserId: null,
        beforeState: {},
        afterState: {},
        reason: null,
        ipAddress: ipOf(req),
      });
    } catch (err) {
      lastPoolViewAuditAtByAdmin.set(admin.id, lastAt);
      req.log.warn({ err }, "ALLOCATION_POOL_VIEWED audit insert failed");
    }
  }
  const r = await recomputeMasterPool();
  if (!r.ok || !r.pool) {
    res.status(200).json({ ok: true, pool: null, reason: r.reason ?? "UNKNOWN" });
    return;
  }
  // Derive bridgeAvailability + bridgeMessage server-side so the admin
  // UI does not have to reproduce the rule. Mirrors getUserAllocationView.
  const p = r.pool;
  let bridgeAvailability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE" = "HEALTHY";
  let bridgeMessage = "Live bridge is healthy.";
  if (p.sharedLivePaused) {
    bridgeAvailability = "UNAVAILABLE";
    bridgeMessage = "Live bridge is paused for reconciliation.";
  } else if (p.snapshotStatus === "MISSING") {
    bridgeAvailability = "UNAVAILABLE";
    bridgeMessage = "Live bridge is offline.";
  } else if (p.snapshotStatus === "STALE") {
    bridgeAvailability = "RECONCILING";
    bridgeMessage = "Live bridge snapshot is reconciling — please retry shortly.";
  } else if (p.isOverAllocated) {
    bridgeAvailability = "RECONCILING";
    bridgeMessage = "Live bridge allocation is temporarily unavailable while the master balance is being reconciled.";
  }
  const masterCap = Math.min(p.mt5Balance, p.mt5Equity);
  const available = Math.max(0, masterCap - p.totalAllocated);
  res.json({ ok: true, pool: { ...p, bridgeAvailability, bridgeMessage, masterCap, available } });
});

// ── POST /api/admin/allocations/recompute ──────────────────────────────────
// Forced recompute + reconcile of per-allocation reservedRisk. Returns
// the fresh pool snapshot.
router.post("/admin/allocations/recompute", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  await auditInTx(db as unknown as Tx, {
    admin, action: "ALLOCATION_RECONCILIATION_STARTED", targetUserId: null,
    beforeState: {}, afterState: {}, reason: null, ipAddress: ipOf(req),
  });
  const recon = await reconcileAllocationsReservedRisk();
  const r = await recomputeMasterPool();
  await auditInTx(db as unknown as Tx, {
    admin, action: "ALLOCATION_RECONCILIATION_COMPLETED", targetUserId: null,
    beforeState: {}, afterState: { allocationsUpdated: recon.updated, pool: r.pool ?? null },
    reason: null, ipAddress: ipOf(req),
  });
  await mirrorAllocationChange(admin, "ALLOCATION_RECONCILIATION_COMPLETED", null, null);
  res.json({ ok: true, allocationsUpdated: recon.updated, pool: r.pool ?? null });
});

// ── GET /api/admin/live-positions/reconcile-summary ────────────────────────
// Read-only operator view of open arx_live_positions, grouped by user and
// reconcile_state, so operators can spot accumulation of reconciled "ghost"
// rows (IGNORED/EXTERNAL/IMPORTED) before they cause confusion. After the
// June-1 incident (15 IGNORED ghosts for one user) there was no single view
// that separated genuinely-open exposure (reconcile_state IS NULL) from
// already-resolved ghost rows. This endpoint NEVER mutates anything and
// returns NO PII (no email), NO broker tickets, account numbers, or other
// sensitive data — only userId + counts. Admin/OWNER only.
router.get("/admin/live-positions/reconcile-summary", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  // One grouped pass over every OPEN row. reconcile_state NULL = genuinely
  // live exposure; any non-null value is a reconciled/orphan-resolved ghost.
  const grouped = await db.select({
    userId: arxLivePositionsTable.userId,
    reconcileState: arxLivePositionsTable.reconcileState,
    count: sql<number>`count(*)::int`,
  }).from(arxLivePositionsTable)
    .where(isNull(arxLivePositionsTable.closedAt))
    .groupBy(arxLivePositionsTable.userId, arxLivePositionsTable.reconcileState);

  type PerUser = {
    userId: number;
    totalOpen: number;
    genuineOpen: number;
    reconciledCount: number;
    byState: { IGNORED: number; EXTERNAL: number; IMPORTED: number; OTHER: number };
  };
  const byUser = new Map<number, PerUser>();
  const ensure = (userId: number): PerUser => {
    let u = byUser.get(userId);
    if (!u) {
      u = {
        userId, totalOpen: 0, genuineOpen: 0, reconciledCount: 0,
        byState: { IGNORED: 0, EXTERNAL: 0, IMPORTED: 0, OTHER: 0 },
      };
      byUser.set(userId, u);
    }
    return u;
  };
  for (const row of grouped) {
    const u = ensure(row.userId);
    const n = Number(row.count ?? 0);
    u.totalOpen += n;
    const state = row.reconcileState;
    if (state == null) {
      u.genuineOpen += n;
    } else {
      u.reconciledCount += n;
      if (state === "IGNORED") u.byState.IGNORED += n;
      else if (state === "EXTERNAL") u.byState.EXTERNAL += n;
      else if (state === "IMPORTED") u.byState.IMPORTED += n;
      else u.byState.OTHER += n;
    }
  }

  // No email or other PII is joined in — the allocations table already has
  // the user's email and the badge keys this summary by userId.
  const users = Array.from(byUser.values())
    .sort((a, b) => b.reconciledCount - a.reconciledCount || b.totalOpen - a.totalOpen);

  const summary = users.reduce(
    (s, u) => {
      s.totalOpen += u.totalOpen;
      s.genuineOpen += u.genuineOpen;
      s.reconciledCount += u.reconciledCount;
      return s;
    },
    { totalOpen: 0, genuineOpen: 0, reconciledCount: 0, userCount: users.length },
  );

  res.json({ ok: true, users, summary });
});

// ── GET /api/admin/live-positions/:userId/reconcile-detail ─────────────────
// Read-only drilldown behind the allocations "ghost" badge. Lists the
// individual OPEN reconciled rows (reconcile_state IS NOT NULL — the
// IGNORED/EXTERNAL/IMPORTED ghosts already resolved by an operator) for one
// user, so an operator who spots accumulation in the badge can see the rows,
// their state, and the note/reason behind each before deciding to act in the
// Reconciliation Center. This endpoint NEVER mutates anything — every
// resolution still funnels through the existing /admin/bridge/orphans/:id/*
// surfaces. Admin/OWNER only. Scoped strictly to the requested userId (no
// cross-user leak). brokerTicket is returned (admin-only operator surface,
// same as the Reconciliation Center) but never to non-admin sessions.
router.get("/admin/live-positions/:userId/reconcile-detail", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }

  // Open reconciled rows = the exact rows behind the badge's reconciledCount
  // (open = closed_at IS NULL; reconciled = reconcile_state IS NOT NULL).
  const rows = await db.select({
    id: arxLivePositionsTable.id,
    symbol: arxLivePositionsTable.symbol,
    side: arxLivePositionsTable.side,
    volume: arxLivePositionsTable.volume,
    brokerTicket: arxLivePositionsTable.brokerTicket,
    reconcileState: arxLivePositionsTable.reconcileState,
    reconcileNote: arxLivePositionsTable.reconcileNote,
    reconcileReason: arxLivePositionsTable.reconcileReason,
    reconciledByAdminId: arxLivePositionsTable.reconciledByAdminId,
    reconciledAt: arxLivePositionsTable.reconciledAt,
    openedAt: arxLivePositionsTable.openedAt,
  }).from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      isNull(arxLivePositionsTable.closedAt),
      isNotNull(arxLivePositionsTable.reconcileState),
    ))
    .orderBy(desc(arxLivePositionsTable.reconciledAt));

  // Genuine open exposure (reconcile_state IS NULL) — surfaced alongside so the
  // operator sees the real-exposure context next to the ghosts.
  const [genuine] = await db.select({ count: sql<number>`count(*)::int` })
    .from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      isNull(arxLivePositionsTable.closedAt),
      isNull(arxLivePositionsTable.reconcileState),
    ));

  res.json({
    ok: true,
    userId,
    genuineOpen: Number(genuine?.count ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      volume: r.volume,
      brokerTicket: r.brokerTicket,
      reconcileState: r.reconcileState,
      reconcileNote: r.reconcileNote,
      reconcileReason: r.reconcileReason,
      reconciledByAdminId: r.reconciledByAdminId,
      reconciledAt: r.reconciledAt ? r.reconciledAt.toISOString() : null,
      openedAt: r.openedAt ? r.openedAt.toISOString() : null,
    })),
  });
});

// ── POST /api/admin/allocations/:userId/reduce ─────────────────────────────
// Sets a single user's allocation to an absolute new total. Refuses if
// the user has open exposure that the new total would not cover.
const ReduceBody = z.object({
  newTotal: z.number().min(0),
  reason: z.string().min(1).max(500),
});
router.post("/admin/allocations/:userId/reduce", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const userId = parseInt(paramStr(req, "userId"), 10);
  if (!Number.isFinite(userId) || userId <= 0) { res.status(400).json({ ok: false, error: "INVALID_USER_ID" }); return; }
  const parsed = ReduceBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { newTotal, reason } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const before = await loadAllocInTx(tx, userId);
    if (!before) return fail(404, { ok: false, error: "NO_ALLOCATION" });
    const base = normalizeSplit(before);
    const persistedNew = round2(newTotal);
    if (persistedNew > base.total) {
      return fail(400, { ok: false, error: "REDUCE_REQUIRES_LOWER_TOTAL",
        message: "Reduce can only LOWER an allocation. Use /set for increases." });
    }
    // Block reduction below user's current open exposure principal.
    // The previous body was a no-op; we now refuse outright if there
    // are open positions AND the new total drops below the current
    // total minus realised P/L (i.e. would strand open exposure).
    // Operator must pause + close positions first.
    const pnl = await getUserPnl(userId);
    if (pnl.openCount > 0 && persistedNew < base.total - pnl.realisedPnl) {
      return fail(409, {
        ok: false,
        error: "USER_HAS_OPEN_EXPOSURE",
        message: "User has open live positions. Close them or pause shared-live before reducing below covered exposure.",
        openPositions: pnl.openCount,
        currentTotal: base.total,
        attemptedNewTotal: persistedNew,
      });
    }

    const delta = round2(persistedNew - base.total); // ≤ 0
    let newManual = round2(Math.max(0, base.manual + Math.max(delta, -base.manual)));
    const remainingDelta = round2(delta - (newManual - base.manual));
    let newAi = round2(Math.max(0, base.ai + remainingDelta));
    if (newManual + newAi !== persistedNew) {
      // Final safety clamp.
      newManual = round2(Math.max(0, persistedNew - newAi));
      if (newManual + newAi > persistedNew) newAi = round2(Math.max(0, persistedNew - newManual));
    }
    await tx.update(userSlotAllocationTable).set({
      allocatedFunds: persistedNew,
      manualAllocatedFunds: newManual,
      aiAllocatedFunds: newAi,
      updatedAt: new Date(),
    }).where(eq(userSlotAllocationTable.id, before.id));

    const shellSync = await syncVirtualBalanceDeltaInTx(tx, userId, delta);
    await auditInTx(tx, {
      admin, action: "USER_ALLOCATION_REDUCED", targetUserId: userId,
      beforeState: { allocatedFunds: base.total, manualAllocatedFunds: base.manual, aiAllocatedFunds: base.ai },
      afterState: { allocatedFunds: persistedNew, manualAllocatedFunds: newManual, aiAllocatedFunds: newAi, delta, virtualBalanceSynced: shellSync.updated },
      reason, ipAddress: ipOf(req),
    });
    return { ok: true as const, previous: base.total, newTotal: persistedNew };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  // Recompute pool to reflect the change.
  await recomputeMasterPool();
  await mirrorAllocationChange(admin, "USER_ALLOCATION_REDUCED", userId, reason);
  res.json(result);
});

// ── POST /api/admin/allocations/reduce-proportional ────────────────────────
// Reduces ALL active allocations proportionally so the new sum matches
// `targetTotal`. Returns the per-user breakdown.
const ProportionalBody = z.object({
  targetTotal: z.number().min(0),
  reason: z.string().min(1).max(500),
});
router.post("/admin/allocations/reduce-proportional", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = ProportionalBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { targetTotal, reason } = parsed.data;

  const result = await db.transaction(async (tx) => {
    // Serialise against every other allocation mutator so this multi-row
    // reduction cannot deadlock with a path that locks rows in a different
    // order (e.g. transfer / auto-reconcile).
    await acquireAllocationSerializationLock(tx);
    const allRows = await tx.select().from(userSlotAllocationTable).for("update");
    const current = allRows.reduce((s, r) => s + Number(r.allocatedFunds ?? 0), 0);
    if (current <= 0) {
      return fail(409, { ok: false, error: "NO_ALLOCATIONS_TO_REDUCE" });
    }
    if (targetTotal >= current) {
      return fail(400, { ok: false, error: "REDUCE_REQUIRES_LOWER_TOTAL",
        currentTotal: round2(current) });
    }
    const ratio = targetTotal / current;
    const changes: Array<{ userId: number; previous: number; newTotal: number }> = [];
    for (const r of allRows) {
      const prev = Number(r.allocatedFunds ?? 0);
      const newTotal = round2(prev * ratio);
      const baseManual = Number(r.manualAllocatedFunds ?? 0);
      const baseAi = Number(r.aiAllocatedFunds ?? 0);
      const baseSum = baseManual + baseAi;
      const newManual = baseSum > 0 ? round2(newTotal * (baseManual / baseSum)) : newTotal;
      const newAi = round2(Math.max(0, newTotal - newManual));
      await tx.update(userSlotAllocationTable).set({
        allocatedFunds: newTotal,
        manualAllocatedFunds: newManual,
        aiAllocatedFunds: newAi,
        updatedAt: new Date(),
      }).where(eq(userSlotAllocationTable.id, r.id));
      changes.push({ userId: r.userId, previous: prev, newTotal });
    }
    await auditInTx(tx, {
      admin, action: "ALL_ALLOCATIONS_PROPORTIONALLY_REDUCED", targetUserId: null,
      beforeState: { currentTotal: round2(current) },
      afterState: { targetTotal: round2(targetTotal), ratio, changeCount: changes.length },
      reason, ipAddress: ipOf(req),
    });
    return { ok: true as const, currentTotal: round2(current), targetTotal: round2(targetTotal), ratio, changes };
  });

  if (isTxFailure(result)) { res.status(result.status).json(result.body); return; }
  await recomputeMasterPool();
  await mirrorAllocationChange(admin, "ALL_ALLOCATIONS_PROPORTIONALLY_REDUCED", null, reason);
  res.json(result);
});

// ── POST /api/admin/shared-live/pause ──────────────────────────────────────
// Sets pool.sharedLivePaused = true so the dispatch pre-gate refuses
// every new entry. Existing positions are NOT closed. Idempotent.
const PauseBody = z.object({ reason: z.string().min(1).max(500) });
router.post("/admin/shared-live/pause", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = PauseBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "BAD_BODY" }); return; }
  const { reason } = parsed.data;

  await recomputeMasterPool();
  const pool = await loadMasterPool();
  if (!pool) { res.status(409).json({ ok: false, error: "MASTER_BRIDGE_NOT_PINNED" }); return; }
  const [updated] = await db.update(arxMasterBridgePoolTable).set({
    sharedLivePaused: true,
    pausedReason: reason,
    pausedAt: new Date(),
    pausedByUserId: admin.id,
  }).where(eq(arxMasterBridgePoolTable.id, pool.id)).returning();
  await auditInTx(db as unknown as Tx, {
    admin, action: "SHARED_LIVE_PAUSED_OVER_ALLOCATION", targetUserId: null,
    beforeState: { sharedLivePaused: pool.sharedLivePaused },
    afterState: { sharedLivePaused: true, pausedReason: reason },
    reason, ipAddress: ipOf(req),
  });
  await mirrorAllocationChange(admin, "SHARED_LIVE_PAUSED_OVER_ALLOCATION", null, reason);
  res.json({ ok: true, pool: updated });
});

// ── POST /api/admin/shared-live/resume ─────────────────────────────────────
router.post("/admin/shared-live/resume", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const pool = await loadMasterPool();
  if (!pool) { res.status(409).json({ ok: false, error: "MASTER_BRIDGE_NOT_PINNED" }); return; }
  const [updated] = await db.update(arxMasterBridgePoolTable).set({
    sharedLivePaused: false,
    pausedReason: null,
    pausedAt: null,
    pausedByUserId: null,
  }).where(eq(arxMasterBridgePoolTable.id, pool.id)).returning();
  await auditInTx(db as unknown as Tx, {
    admin, action: "SHARED_LIVE_RESUMED", targetUserId: null,
    beforeState: { sharedLivePaused: pool.sharedLivePaused, pausedReason: pool.pausedReason },
    afterState: { sharedLivePaused: false },
    reason: null, ipAddress: ipOf(req),
  });
  await mirrorAllocationChange(admin, "SHARED_LIVE_RESUMED", null, null);
  res.json({ ok: true, pool: updated });
});

export default router;
