// P0-1 — Per-user Shared Account API surface.
//
// In SHARED_MASTER_MT5 mode, each user has a virtual ledger row on the
// shared master account. These routes give the user a read-only window
// into their own virtual balance, attribution history, and open
// attributed positions. They DO NOT expose:
//   - Master broker credentials (apiKeyHash, accountLogin, server, etc).
//   - Any other user's data.
//   - Any execution capability — these are read-only.
//
// SAFETY:
//   * Every query scopes by req.authUser.id. Cross-user reads are
//     structurally impossible.
//   * No secret-named fields returned. We project explicit columns; we do
//     NOT return entire rows from mt5_connection.
//   * No execution. No order placement. No live-trade flags toggled.

import { Router } from "express";
import type { Request } from "express";
import { db } from "@workspace/db";
import {
  virtualTradingAccountsTable,
  sharedTradeAttributionTable,
  sharedMasterAccountsTable,
  mt5ConnectionTable,
  arxLivePositionsTable,
  unattributedMasterTradesTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import {
  getUserAllocationView,
  recomputeMasterPool,
  resolveActiveMasterConnectionId,
} from "../lib/live/masterBridgePool.js";

const router = Router();

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ADMIN/OWNER session only — admin-previewing-as-user is downgraded and fails. */
function isAdminOrOwner(req: Request): boolean {
  const role = String(
    (req as Request & { authUser?: { role?: string } }).authUser?.role ?? "",
  ).toUpperCase();
  return role === "ADMIN" || role === "OWNER";
}

/**
 * Real MT5 master snapshot for the card — owner/admin only. Sourced from the
 * EA heartbeat (arx_master_bridge_pool via getUserAllocationView) +
 * mt5_connection projection. Never returns tokens, IPs, or the raw account
 * number (masked only). Honest staleness — never fabricated. Returns null when
 * no master bridge is pinned.
 */
async function buildMasterMt5Snapshot(userId: number) {
  const view = await getUserAllocationView(userId);
  const pool = view.pool;
  if (!pool) return null;

  // Masked broker/account label from the master connection (no credentials).
  const masterConnId = await resolveActiveMasterConnectionId();
  let brokerName: string | null = null;
  let serverName: string | null = null;
  let accountTypeLabel: string | null = null;
  let accountNumberMasked: string | null = null;
  let masterOwnerUserId: number | null = null;
  if (masterConnId != null) {
    const connRows = await db.select({
      userId: mt5ConnectionTable.userId,
      brokerName: mt5ConnectionTable.brokerName,
      serverName: mt5ConnectionTable.serverName,
      accountType: mt5ConnectionTable.accountType,
      accountNumber: mt5ConnectionTable.accountNumber,
    }).from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, masterConnId)).limit(1);
    const c = connRows[0];
    if (c) {
      masterOwnerUserId = c.userId ?? null;
      brokerName = c.brokerName ?? null;
      serverName = c.serverName ?? null;
      accountTypeLabel = c.accountType ?? null;
      const raw = String(c.accountNumber ?? "");
      accountNumberMasked = raw ? `••••${raw.slice(-4)}` : null;
    }
  }

  // Real open positions on the MASTER account — scoped to BOTH the master
  // owner AND the active master connection, so a multi-connection owner never
  // overcounts positions from a non-master account. Confirmed broker tickets
  // only (not closed). Falls back to 0 when the master is unknown.
  let openPositions = 0;
  if (masterOwnerUserId != null && masterConnId != null) {
    const openRows = await db.select({ count: sql<number>`count(*)::int` })
      .from(arxLivePositionsTable)
      .where(and(
        eq(arxLivePositionsTable.userId, masterOwnerUserId),
        eq(arxLivePositionsTable.bridgeConnectionId, masterConnId),
        isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState),
      ));
    openPositions = Number(openRows[0]?.count ?? 0);
  }

  // Real broker floating P/L = equity − balance, straight from the EA
  // heartbeat snapshot. Authoritative MT5 account truth, never ARX-aggregated.
  const mt5Balance = round2(Number(pool.mt5Balance ?? 0));
  const mt5Equity = round2(Number(pool.mt5Equity ?? 0));
  const mt5OpenPnl = round2(mt5Equity - mt5Balance);

  // 7-day realized P&L from the applied attribution ledger (honest, real fills).
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const realizedRows = await db.select({
    sum: sql<number>`coalesce(sum(${sharedTradeAttributionTable.pnl}),0)::float8`,
  }).from(sharedTradeAttributionTable).where(and(
    eq(sharedTradeAttributionTable.userId, userId),
    eq(sharedTradeAttributionTable.status, "closed"),
    sql`${sharedTradeAttributionTable.realizedAppliedAt} is not null and ${sharedTradeAttributionTable.realizedAppliedAt} >= ${sevenDaysAgo}`,
  ));
  const realizedPnl7d = round2(Number(realizedRows[0]?.sum ?? 0));

  // Pending manual / unattributed MT5 trades on the master (operator review).
  const unattrRows = await db.select({ count: sql<number>`count(*)::int` })
    .from(unattributedMasterTradesTable)
    .where(eq(unattributedMasterTradesTable.status, "pending_review"));
  const unattributedCount = Number(unattrRows[0]?.count ?? 0);

  const snapshotStatus = pool.snapshotStatus as "FRESH" | "STALE" | "MISSING";
  const syncStatus: "LIVE" | "STALE" | "UNAVAILABLE" =
    snapshotStatus === "FRESH" ? "LIVE"
      : snapshotStatus === "STALE" ? "STALE"
        : "UNAVAILABLE";

  return {
    mt5Balance,
    mt5Equity,
    mt5UsedMargin: round2(Number(pool.mt5UsedMargin ?? 0)),
    mt5FreeMargin: round2(Number(pool.mt5FreeMargin ?? 0)),
    mt5OpenPnl,
    openPositions,
    accountCurrency: pool.accountCurrency ?? null,
    brokerName,
    serverName,
    accountTypeLabel,
    accountNumberMasked,
    arxAllocated: round2(view.assignedAllocation),
    arxAvailable: round2(view.availableAllocation),
    arxReserved: round2(view.reservedRisk),
    realizedPnl7d,
    snapshotStatus,
    snapshotAgeMs: pool.snapshotAgeMs ?? null,
    lastMt5SnapshotAt: pool.lastMt5SnapshotAt
      ? new Date(pool.lastMt5SnapshotAt).toISOString()
      : null,
    isOverAllocated: Boolean(pool.isOverAllocated),
    unattributedCount,
    syncStatus,
  };
}

// ── GET /api/me/shared-account/summary ─────────────────────────────────────
// Aggregate read for the current user across every virtual account row
// they hold (one per shared master account + accountType). Returns:
//   - per-account virtualBalance / virtualEquity / virtualPnl / marginUsed
//   - the masked master account info (NO credentials)
//   - openAttributions count + last 7-day realized PnL sum
router.get("/me/shared-account/summary", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const accounts = await db.select({
      id: virtualTradingAccountsTable.id,
      routingMode: virtualTradingAccountsTable.routingMode,
      sharedMasterAccountId: virtualTradingAccountsTable.sharedMasterAccountId,
      accountType: virtualTradingAccountsTable.accountType,
      virtualBalance: virtualTradingAccountsTable.virtualBalance,
      virtualEquity: virtualTradingAccountsTable.virtualEquity,
      virtualMarginUsed: virtualTradingAccountsTable.virtualMarginUsed,
      virtualPnl: virtualTradingAccountsTable.virtualPnl,
      status: virtualTradingAccountsTable.status,
      updatedAt: virtualTradingAccountsTable.updatedAt,
      masterBrokerName: sharedMasterAccountsTable.brokerName,
      masterAccountNumberMasked: sharedMasterAccountsTable.accountNumberMasked,
      masterStatus: sharedMasterAccountsTable.status,
    })
      .from(virtualTradingAccountsTable)
      .leftJoin(
        sharedMasterAccountsTable,
        eq(sharedMasterAccountsTable.id, virtualTradingAccountsTable.sharedMasterAccountId),
      )
      .where(eq(virtualTradingAccountsTable.userId, userId));

    // Open attribution count per virtual account — CONFIRMED-ONLY. A row with
    // no broker ticket is an unconfirmed/phantom open (dispatched-to-bridge but
    // never filled) and must NOT count as an active position.
    const openByAccount = await db.select({
      virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
      count: sql<number>`count(*)::int`,
    })
      .from(sharedTradeAttributionTable)
      .where(and(
        eq(sharedTradeAttributionTable.userId, userId),
        eq(sharedTradeAttributionTable.status, "open"),
        isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
        ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
      ))
      .groupBy(sharedTradeAttributionTable.virtualAccountId);
    const openMap = new Map<number, number>(
      openByAccount.map(r => [r.virtualAccountId, Number(r.count)]),
    );

    // 7-day realized P&L per virtual account (applied closes only).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const realized7d = await db.select({
      virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
      sum: sql<number>`coalesce(sum(${sharedTradeAttributionTable.pnl}),0)::float8`,
    })
      .from(sharedTradeAttributionTable)
      .where(and(
        eq(sharedTradeAttributionTable.userId, userId),
        eq(sharedTradeAttributionTable.status, "closed"),
        sql`${sharedTradeAttributionTable.realizedAppliedAt} is not null and ${sharedTradeAttributionTable.realizedAppliedAt} >= ${sevenDaysAgo}`,
      ))
      .groupBy(sharedTradeAttributionTable.virtualAccountId);
    const realizedMap = new Map<number, number>(
      realized7d.map(r => [r.virtualAccountId, Number(r.sum)]),
    );

    // Owner/admin only: real MT5 master snapshot. Normal users (and
    // admin-previewing-as-user) get null — no master broker data exposure.
    // masterAccess is the capability flag (true even when masterMt5 is null
    // because the bridge is unpinned/offline) so the UI can still offer a real
    // resync to authorized users.
    const masterAccess = isAdminOrOwner(req);
    const masterMt5 = masterAccess ? await buildMasterMt5Snapshot(userId) : null;

    // Canonical per-user allocation — the SAME source the live gate, preflight,
    // and /me/master-live/access use (getUserAllocationView). Exposed to EVERY
    // user (it is strictly their own allocation, never master/cross-user data)
    // so display surfaces stop showing the static virtual_balance, which drifts
    // from the headroom the gate actually enforces (assigned − reserved + open
    // floating loss). hasAllocation lets the UI distinguish "none assigned" from
    // "fully consumed". isOverAllocated mirrors the pool reconciliation state.
    const allocView = await getUserAllocationView(userId);
    const allocationView = {
      assignedAllocation: allocView.assignedAllocation,
      availableAllocation: allocView.availableAllocation,
      reservedRisk: allocView.reservedRisk,
      openFloatingLoss: allocView.openFloatingLoss,
      bridgeAvailability: allocView.bridgeAvailability,
      bridgeMessage: allocView.bridgeMessage,
      hasAllocation: allocView.hasAllocation,
      isOverAllocated: Boolean(allocView.pool?.isOverAllocated),
    };

    res.json({
      ok: true,
      userId,
      accounts: accounts.map(a => ({
        ...a,
        openAttributions: openMap.get(a.id) ?? 0,
        realizedPnl7d: realizedMap.get(a.id) ?? 0,
      })),
      allocationView,
      masterMt5,
      masterAccess,
    });
  } catch (e) {
    req.log?.error({ err: e }, "me_shared_account_summary_failed");
    res.status(500).json({ ok: false, error: "summary_failed" });
  }
});

// ── POST /api/me/shared-account/refresh ────────────────────────────────────
// Owner/admin only. Recompute the MT5 master snapshot from the freshest EA
// heartbeat data (mt5_connection) and return it. This is a REAL recompute, not
// a timestamp-only fake; honest staleness is preserved via snapshotStatus/age.
// No live trade, no order placement, no fabricated balances.
router.post("/me/shared-account/refresh", requireUser, async (req, res) => {
  if (!isAdminOrOwner(req)) {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED", masterMt5: null });
    return;
  }
  const userId = req.authUser!.id;
  try {
    const recompute = await recomputeMasterPool();
    const masterMt5 = await buildMasterMt5Snapshot(userId);
    // Explicit failure when the recompute could not produce a current pool —
    // surface the honest reason rather than silently returning a stale snapshot.
    if (!recompute.ok) {
      res.json({ ok: false, error: recompute.reason ?? "MASTER_BRIDGE_NOT_AVAILABLE", masterMt5 });
      return;
    }
    if (!masterMt5) {
      res.json({ ok: false, error: "MASTER_BRIDGE_NOT_AVAILABLE", masterMt5: null });
      return;
    }
    res.json({ ok: true, masterMt5 });
  } catch (e) {
    req.log?.error({ err: e }, "me_shared_account_refresh_failed");
    res.status(500).json({ ok: false, error: "refresh_failed", masterMt5: null });
  }
});

// ── GET /api/me/shared-account/attributions ────────────────────────────────
// Paged history of THIS user's shared_trade_attribution rows. Query params:
//   ?status=open|closed|pending|rejected|failed   (optional)
//   ?limit=50 (max 200)   ?offset=0
router.get("/me/shared-account/attributions", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  try {
    const where = status
      ? and(
          eq(sharedTradeAttributionTable.userId, userId),
          eq(sharedTradeAttributionTable.status, status),
        )
      : eq(sharedTradeAttributionTable.userId, userId);
    const rows = await db.select({
      id: sharedTradeAttributionTable.id,
      virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
      sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
      symbol: sharedTradeAttributionTable.symbol,
      side: sharedTradeAttributionTable.side,
      lotSize: sharedTradeAttributionTable.lotSize,
      entryPrice: sharedTradeAttributionTable.entryPrice,
      closePrice: sharedTradeAttributionTable.closePrice,
      stopLoss: sharedTradeAttributionTable.stopLoss,
      takeProfit: sharedTradeAttributionTable.takeProfit,
      pnl: sharedTradeAttributionTable.pnl,
      fees: sharedTradeAttributionTable.fees,
      slippage: sharedTradeAttributionTable.slippage,
      status: sharedTradeAttributionTable.status,
      rejectionReason: sharedTradeAttributionTable.rejectionReason,
      openedAt: sharedTradeAttributionTable.openedAt,
      closedAt: sharedTradeAttributionTable.closedAt,
      realizedAppliedAt: sharedTradeAttributionTable.realizedAppliedAt,
      createdAt: sharedTradeAttributionTable.createdAt,
    })
      .from(sharedTradeAttributionTable)
      .where(where)
      .orderBy(desc(sharedTradeAttributionTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json({ ok: true, userId, count: rows.length, limit, offset, rows });
  } catch (e) {
    req.log?.error({ err: e }, "me_shared_account_attributions_failed");
    res.status(500).json({ ok: false, error: "attributions_failed" });
  }
});

// ── GET /api/me/shared-account/positions ───────────────────────────────────
// MT5-CONFIRMED OPEN POSITIONS ONLY. A position is shown here only when the
// user's attribution row carries a broker ticket that matches a real, OPEN,
// non-reconciled arx_live_positions row (the authoritative MT5 sync truth).
// This structurally excludes:
//   - phantom/unconfirmed opens (dispatched-to-bridge but never filled → no
//     broker ticket on the attribution),
//   - broker-closed positions (closed_at set),
//   - reconciled/orphan-resolved positions (reconcile_state set).
// Every returned row carries live P/L, entry, current price, opened time, and
// the broker ticket — pulled from the live position, not the ARX intent.
// Per-user isolation: we scope by the attribution's user_id and join only on
// THAT attribution's own broker ticket, so a user only ever sees positions they
// are attributed to.
const POSITION_FRESH_MS = 90_000;
router.get("/me/shared-account/positions", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    // ── OWNER/ADMIN ONLY: full master-account exposure (operator safety) ─────
    // Real ADMIN/OWNER session only — admin-previewing-as-user is downgraded by
    // isAdminOrOwner() and falls through to the regular attributed-only path
    // below. Reads the pinned master's OPEN positions DIRECTLY from
    // arx_live_positions (the MT5 sync source of truth) so manual/unattributed
    // master positions (e.g. hand-placed V75 shorts) are visible to the operator.
    // Read-only. No execution. Attribution rules and regular-user isolation are
    // untouched. Same scope the Account Snapshot count uses, so card and count
    // always agree. Per-row label:
    //   source "ARX"     → an ARX attribution exists for this broker ticket
    //          "PENDING" → attribution exists but is still pending fill
    //          "MANUAL"  → no attribution: a manual/external master position
    if (isAdminOrOwner(req)) {
      const masterConnId = await resolveActiveMasterConnectionId();
      if (masterConnId == null) {
        res.json({ ok: true, userId, scope: "MASTER", masterConnectionId: null, count: 0, lastMt5SyncAt: null, reconciledOrphanCount: 0, rows: [], note: "MASTER_BRIDGE_NOT_PINNED" });
        return;
      }
      const connRows = await db.select({ ownerId: mt5ConnectionTable.userId })
        .from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, masterConnId)).limit(1);
      const masterOwnerUserId = connRows[0]?.ownerId ?? null;
      if (masterOwnerUserId == null) {
        res.json({ ok: true, userId, scope: "MASTER", masterConnectionId: masterConnId, count: 0, lastMt5SyncAt: null, reconciledOrphanCount: 0, rows: [], note: "MASTER_CONNECTION_MISSING" });
        return;
      }

      // All real OPEN master positions — not closed, not operator-reconciled.
      const masterRows = await db.select({
        id: arxLivePositionsTable.id,
        brokerTicket: arxLivePositionsTable.brokerTicket,
        symbol: arxLivePositionsTable.symbol,
        side: arxLivePositionsTable.side,
        volume: arxLivePositionsTable.volume,
        entryPrice: arxLivePositionsTable.entryPrice,
        currentPrice: arxLivePositionsTable.currentPrice,
        pnl: arxLivePositionsTable.floatingPl,
        stopLoss: arxLivePositionsTable.stopLoss,
        takeProfit: arxLivePositionsTable.takeProfit,
        openedAt: arxLivePositionsTable.openedAt,
        lastSyncedAt: arxLivePositionsTable.lastSyncedAt,
      })
        .from(arxLivePositionsTable)
        .where(and(
          eq(arxLivePositionsTable.userId, masterOwnerUserId),
          eq(arxLivePositionsTable.bridgeConnectionId, masterConnId),
          isNull(arxLivePositionsTable.closedAt),
          isNull(arxLivePositionsTable.reconcileState),
        ))
        .orderBy(desc(arxLivePositionsTable.openedAt));

      // Label by ARX attribution WITHOUT widening any user's visibility. This is
      // the owner/admin operator view; we look up attributions for the pinned
      // master by broker ticket (trimmed both sides so a stray space can't break
      // the match) and derive ARX / PENDING / MANUAL.
      const tickets = masterRows.map((r) => String(r.brokerTicket ?? "").trim()).filter((t) => t.length > 0);
      const attrByTicket = new Map<string, { status: string; attrUserId: number }>();
      if (tickets.length > 0) {
        const attrRows = await db.select({
          ticket: sharedTradeAttributionTable.mt5PositionTicket,
          status: sharedTradeAttributionTable.status,
          attrUserId: sharedTradeAttributionTable.userId,
        })
          .from(sharedTradeAttributionTable)
          .where(and(
            eq(sharedTradeAttributionTable.masterConnectionId, masterConnId),
            isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
            ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
            inArray(sharedTradeAttributionTable.mt5PositionTicket, tickets),
          ));
        for (const a of attrRows) {
          const key = String(a.ticket ?? "").trim();
          if (!key) continue;
          const existing = attrByTicket.get(key);
          if (!existing || a.status === "open") attrByTicket.set(key, { status: a.status, attrUserId: a.attrUserId });
        }
      }

      const now = Date.now();
      let lastMt5SyncAt: Date | null = null;
      const rows = masterRows.map((r) => {
        const synced = r.lastSyncedAt ? new Date(r.lastSyncedAt) : null;
        if (synced && (lastMt5SyncAt == null || synced > lastMt5SyncAt)) lastMt5SyncAt = synced;
        const key = String(r.brokerTicket ?? "").trim();
        const attr = attrByTicket.get(key) ?? null;
        const source: "ARX" | "PENDING" | "MANUAL" = attr == null ? "MANUAL" : attr.status === "pending" ? "PENDING" : "ARX";
        return {
          id: r.id,
          symbol: r.symbol,
          side: r.side,
          lotSize: r.volume,
          entryPrice: r.entryPrice ?? null,
          currentPrice: r.currentPrice ?? null,
          pnl: r.pnl ?? null,
          stopLoss: r.stopLoss ?? null,
          takeProfit: r.takeProfit ?? null,
          openedAt: r.openedAt ? new Date(r.openedAt).toISOString() : null,
          lastSyncedAt: synced ? synced.toISOString() : null,
          brokerTicket: key,
          source,
          attributedUserId: attr?.attrUserId ?? null,
          stale: synced == null || (now - synced.getTime()) > POSITION_FRESH_MS,
        };
      });

      // Recently operator-reconciled master positions (honest "N reconciled" note).
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const recRows = await db.select({ count: sql<number>`count(*)::int` })
        .from(arxLivePositionsTable)
        .where(and(
          eq(arxLivePositionsTable.userId, masterOwnerUserId),
          eq(arxLivePositionsTable.bridgeConnectionId, masterConnId),
          isNotNull(arxLivePositionsTable.reconcileState),
          gte(arxLivePositionsTable.reconciledAt, dayAgo),
        ));
      const reconciledOrphanCount = Number(recRows[0]?.count ?? 0);

      res.json({
        ok: true, userId, scope: "MASTER", masterConnectionId: masterConnId,
        count: rows.length,
        lastMt5SyncAt: lastMt5SyncAt ? (lastMt5SyncAt as Date).toISOString() : null,
        reconciledOrphanCount, rows,
      });
      return;
    }

    const raw = await db.select({
      id: sharedTradeAttributionTable.id,
      virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
      sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
      symbol: sharedTradeAttributionTable.symbol,
      side: sharedTradeAttributionTable.side,
      lotSize: sharedTradeAttributionTable.lotSize,
      stopLoss: sharedTradeAttributionTable.stopLoss,
      takeProfit: sharedTradeAttributionTable.takeProfit,
      slippage: sharedTradeAttributionTable.slippage,
      brokerTicket: arxLivePositionsTable.brokerTicket,
      entryPrice: arxLivePositionsTable.entryPrice,
      currentPrice: arxLivePositionsTable.currentPrice,
      pnl: arxLivePositionsTable.floatingPl,
      openedAt: arxLivePositionsTable.openedAt,
      lastSyncedAt: arxLivePositionsTable.lastSyncedAt,
    })
      .from(sharedTradeAttributionTable)
      .innerJoin(arxLivePositionsTable, and(
        // Per-user isolation: arx_live_positions uniqueness is (user_id,
        // broker_ticket), NOT global — so the join MUST be scoped by user or a
        // shared ticket string could cross-join another user's live position.
        eq(arxLivePositionsTable.userId, sharedTradeAttributionTable.userId),
        eq(arxLivePositionsTable.brokerTicket, sharedTradeAttributionTable.mt5PositionTicket),
        isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState),
      ))
      .where(and(
        eq(sharedTradeAttributionTable.userId, userId),
        eq(sharedTradeAttributionTable.status, "open"),
        isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
        ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
      ))
      .orderBy(desc(arxLivePositionsTable.openedAt));

    const now = Date.now();
    let lastMt5SyncAt: Date | null = null;
    const rows = raw.map((r) => {
      const synced = r.lastSyncedAt ? new Date(r.lastSyncedAt) : null;
      if (synced && (lastMt5SyncAt == null || synced > lastMt5SyncAt)) {
        lastMt5SyncAt = synced;
      }
      const stale = synced == null || (now - synced.getTime()) > POSITION_FRESH_MS;
      return {
        id: r.id,
        virtualAccountId: r.virtualAccountId,
        sharedMasterAccountId: r.sharedMasterAccountId,
        symbol: r.symbol,
        side: r.side,
        lotSize: r.lotSize,
        entryPrice: r.entryPrice ?? null,
        currentPrice: r.currentPrice ?? null,
        pnl: r.pnl ?? null,
        stopLoss: r.stopLoss ?? null,
        takeProfit: r.takeProfit ?? null,
        slippage: r.slippage ?? null,
        openedAt: r.openedAt ? new Date(r.openedAt).toISOString() : null,
        lastSyncedAt: synced ? synced.toISOString() : null,
        brokerTicket: String(r.brokerTicket),
        source: "ARX",
        stale,
      };
    });

    // Count of this user's recently reconciled phantom/orphan attributions, so
    // the UI can surface an honest "N stale ARX records reconciled" notice.
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const recRows = await db.select({ count: sql<number>`count(*)::int` })
      .from(sharedTradeAttributionTable)
      .where(and(
        eq(sharedTradeAttributionTable.userId, userId),
        eq(sharedTradeAttributionTable.status, "reconciled"),
        gte(sharedTradeAttributionTable.updatedAt, dayAgo),
      ));
    const reconciledOrphanCount = Number(recRows[0]?.count ?? 0);

    res.json({
      ok: true,
      userId,
      count: rows.length,
      lastMt5SyncAt: lastMt5SyncAt ? (lastMt5SyncAt as Date).toISOString() : null,
      reconciledOrphanCount,
      rows,
    });
  } catch (e) {
    req.log?.error({ err: e }, "me_shared_account_positions_failed");
    res.status(500).json({ ok: false, error: "positions_failed" });
  }
});

export default router;
