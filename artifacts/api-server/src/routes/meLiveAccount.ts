// Per-user live slot summary. Read-only.
//
// SAFETY:
// - Strictly per-user. Every query is scoped by req.authUser.id. A user
//   can never see another user's slot, positions, or allocation. The
//   shared MASTER MT5 balance/equity/margin is NEVER returned here.
// - No fake ownership: positions are read straight from arx_live_positions
//   where userId matches the caller. Closed rows contribute to realised
//   P/L; open rows contribute to floating P/L and estimated used margin.
// - No order placement, no kill switch, no admin approval, no auto-close.
// - When no allocation exists, we return zeros + an explicit honest note
//   instead of fabricating a balance.

import { Router, type Request, type Response } from "express";
import { and, eq, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { openLiveExposureCondition } from "../lib/live/livePositionExposure.js";
import { isForexPair } from "../lib/mt5/contractSize.js";
import {
  db,
  arxLivePositionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
} from "@workspace/db";
import {
  isSnapshotReliable,
  classifyRow,
  POSITION_SYNC_INCOMPLETE_WARNING,
} from "../lib/live/positionFreshness.js";
import {
  buildInvestorLiveBalanceSnapshot,
  toInvestorLiveBalanceWire,
} from "../lib/live/investorLiveBalance.js";

const router = Router();

function uid(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number } }).authUser;
  return u?.id ?? null;
}

const HEARTBEAT_LIVE_MS = 20_000;

// Conservative notional-based margin estimate used ONLY when EA does not
// push per-position margin. Forex standard lot = 100,000 base units.
// Marked internally as estimated so the UI / admin views can show source.
function estimateMarginUsd(volume: number, price: number, leverage: number): number {
  if (!Number.isFinite(volume) || !Number.isFinite(price) || !Number.isFinite(leverage) || leverage <= 0) {
    return 0;
  }
  return (volume * 100_000 * price) / leverage;
}

// The 100,000-unit notional formula above is ONLY valid for spot forex pairs.
// Synthetic indices, metals, crypto and CFDs have their own contract sizes that
// the EA does not report, so applying the forex formula to them fabricates a
// wildly wrong margin (e.g. a 20-lot index priced ~4,500 would imply hundreds
// of millions in margin). We therefore estimate margin ONLY for forex symbols
// and honestly flag the total as incomplete when a non-forex position is held.
// Strict forex classifier: BOTH halves must be ISO-4217 fiat currency codes.
// A loose /^[A-Z]{6}/ test would mis-classify metals (XAUUSD, XAGUSD), crypto
// (BTCUSD) and other CFDs as forex and re-fabricate a 100k-notional margin for
// them — exactly what this guard exists to prevent.
//
// P0-2 — the classifier and its FIAT_CODES allowlist used to be inlined here.
// Realized-P/L sizing needs exactly the same rule, so it now lives in
// `lib/mt5/contractSize.ts` as the single definition and is imported here.
// Two copies would drift, and a drifted copy re-introduces the mis-sizing.

router.get("/me/live/slot-summary", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }

  // 1. Allocation row (zero/empty if absent — no fake balance).
  const allocRows = await db.select().from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId)).limit(1);
  const alloc = allocRows[0];
  const allocatedFunds = alloc ? Number(alloc.allocatedFunds) : 0;
  const accountCurrency = alloc?.accountCurrency ?? "USD";
  const isAllocated = Boolean(alloc?.isActive);
  const isFrozen = Boolean(alloc && (alloc.allocationStatus === "frozen" || alloc.tradingFrozen));
  const freezeMessage = alloc?.allocationStatus === "frozen"
    ? "Your live account has been paused by an operator."
    : alloc?.tradingFrozen
      ? "Trading has been temporarily paused on your account."
      : null;
  const aiSleeve = alloc
    ? {
        enabled: alloc.aiAutoTradingEnabled,
        amount: Number(alloc.aiAllocatedFunds),
        mode: alloc.aiStrategyMode,
        maxLot: alloc.aiMaxLot != null ? Number(alloc.aiMaxLot) : null,
        maxDailyLossUsd: alloc.aiMaxDailyLossUsd != null ? Number(alloc.aiMaxDailyLossUsd) : null,
        frozen: alloc.aiTradingFrozen,
      }
    : null;

  // 2. Open positions for this user only.
  // Open exposure only (shared truth predicate) — reconciled/closed ghosts
  // excluded from the user's account totals.
  const openPositions = await db.select().from(arxLivePositionsTable)
    .where(openLiveExposureCondition(userId));

  // 3. Realised P/L = sum of floatingPl on positions the broker CONFIRMED
  //    closed (a real CLOSE fill stamped closed_at). Reconciled ghosts
  //    (RECONCILED_BROKER_ABSENT / IGNORED / EXTERNAL / IMPORTED) are excluded:
  //    their frozen floatingPl is the LAST-SEEN floating value, not a trusted
  //    realised close P/L (the EA never sent a close event), so summing it would
  //    fabricate realised P/L. Mirrors openLiveExposureCondition's reconcile
  //    filter on the closed side.
  const closedRows = await db.select({
    realised: sql<number>`coalesce(sum(${arxLivePositionsTable.floatingPl}), 0)`,
  }).from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      isNotNull(arxLivePositionsTable.closedAt),
      isNull(arxLivePositionsTable.reconcileState),
    ));
  const realisedPnl = Number(closedRows[0]?.realised ?? 0);

  // 4. The user's own bridge connection (used for leverage + heartbeat
  //    freshness). We do NOT read accountBalance/accountEquity from the
  //    master connection here — that is admin-only.
  // Pick the user's ACTIVE bridge — the non-revoked connection with the most
  // recent heartbeat — NOT the oldest by id. A user can accumulate several
  // connection rows over time (old demo/live bridges, rotated tokens); reading
  // the lowest id would surface a long-dead bridge's heartbeat/leverage and
  // wrongly mark a live, actively-syncing account as stale.
  const connRows = await db.select().from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      ne(mt5ConnectionTable.status, "revoked"),
      // Live slot summary must reflect a LIVE/REAL bridge. Exclude demo bridges
      // so a fresh demo connection can't masquerade as the live account's
      // heartbeat/leverage. Keep unknown/null (not-yet-classified live bridge):
      // a bare ne() would drop NULL rows under SQL three-valued logic, so OR in
      // the null case explicitly even though the column is currently NOT NULL.
      or(isNull(mt5ConnectionTable.accountType), ne(mt5ConnectionTable.accountType, "demo")),
    ))
    .orderBy(sql`${mt5ConnectionTable.lastHeartbeat} desc nulls last`)
    .limit(1);
  const conn = connRows[0];
  const leverage = conn?.leverage ?? 100;
  const lastHeartbeat = conn?.lastHeartbeat ?? null;
  const heartbeatAgeMs = lastHeartbeat ? Date.now() - new Date(lastHeartbeat).getTime() : null;
  const isLive = heartbeatAgeMs !== null && heartbeatAgeMs <= HEARTBEAT_LIVE_MS;
  const isStale = heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_LIVE_MS;

  // 5. Freshness. The EA pushes a COMPLETE open-positions snapshot every ~5s,
  // so a row's lastSyncedAt is when the broker last confirmed it open. CRITICAL:
  // a stale lastSyncedAt does NOT, by itself, mean the position closed. A
  // stale/missing row is broker-confirmed-absent (and excluded from the live
  // book) ONLY when we also have a reliable recent snapshot that excluded it
  // (see positionFreshness.ts). If the latest snapshot is itself stale/missing
  // (bridge lagging, EA offline, incomplete push) we keep ALL open positions —
  // including synthetic-index (V75/V25) rows — visible and flag the book as
  // pending broker confirmation. Presentation-only: we never mutate or
  // auto-close rows here (ALERT_ONLY); closedAt is the only authoritative
  // closed signal.
  const SNAPSHOT_FRESH_MS = 30_000;
  const now = Date.now();
  const bridgeAlive = isLive;
  const accountDataFreshness: "FRESH" | "STALE" | "MISSING" =
    lastHeartbeat == null ? "MISSING" : bridgeAlive ? "FRESH" : "STALE";
  // Reliability is driven by the bridge's "complete sweep landed" marker
  // (last_positions_snapshot_at), stamped on EVERY ingest including an empty
  // book — NOT by the newest row timestamp (which decays to unreliable on a
  // flat broker and would pin closed rows in the totals). The marker stays
  // fresh only while the EA keeps delivering sweeps.
  const snapshotAtMs = conn?.lastPositionsSnapshotAt
    ? new Date(conn.lastPositionsSnapshotAt).getTime()
    : null;
  const snapshotReliable = isSnapshotReliable(snapshotAtMs, SNAPSHOT_FRESH_MS, now);

  // 6. Derive floating P/L, used-margin estimate, per-position payload. We count
  //    every VISIBLE open position (broker-confirmed-fresh, plus stale/missing
  //    rows kept visible while the snapshot is unreliable). Only rows the broker
  //    confirms absent (reliable snapshot excluded them) drop out of the totals.
  let openPnL = 0;
  let usedMargin = 0;
  let stalePositionCount = 0;
  let lastSnapshotMs: number | null = null;
  // True when a visible, held position could NOT be margin-estimated (non-forex
  // such as V75/V25), so the margin/free-margin totals are a forex-only lower
  // bound — we never fabricate a synthetic-index margin.
  let marginEstimateIncomplete = false;
  const slotBalanceForPct = allocatedFunds + realisedPnl;
  const mapped = openPositions.map((p) => {
    const syncedMs = p.lastSyncedAt ? new Date(p.lastSyncedAt).getTime() : null;
    if (syncedMs != null) {
      lastSnapshotMs = lastSnapshotMs == null ? syncedMs : Math.max(lastSnapshotMs, syncedMs);
    }
    const cls = classifyRow(syncedMs, { windowMs: SNAPSHOT_FRESH_MS, now, snapshotReliable });
    // Visible = not broker-confirmed-absent. A stale row stays visible (and
    // counted) whenever we lack a reliable snapshot proving it closed.
    const visible = !cls.brokerConfirmedAbsent;
    const floating = p.floatingPl != null ? Number(p.floatingPl) : 0;
    const vol = Number(p.volume);
    const price = p.currentPrice != null ? Number(p.currentPrice) : Number(p.entryPrice);
    // Margin is estimable only for forex (known 100k contract size). For other
    // instruments (synthetic indices, metals, crypto) the EA reports no contract
    // size, so we never fabricate one — margin is shown as unavailable instead.
    const forex = isForexPair(p.symbol);
    const marginEst = forex ? estimateMarginUsd(vol, price, leverage) : 0;
    if (visible) {
      openPnL += floating;
      usedMargin += marginEst;
      if (!forex) marginEstimateIncomplete = true;
    } else {
      stalePositionCount += 1;
    }
    const profitPercentOfSlot = slotBalanceForPct > 0 ? (floating / slotBalanceForPct) * 100 : null;
    return {
      brokerTicket: p.brokerTicket,
      symbol: p.symbol,
      direction: p.side,
      volume: vol,
      entryPrice: Number(p.entryPrice),
      currentPrice: p.currentPrice != null ? Number(p.currentPrice) : null,
      stopLoss: p.stopLoss != null ? Number(p.stopLoss) : null,
      takeProfit: p.takeProfit != null ? Number(p.takeProfit) : null,
      grossProfit: floating,
      // EA does not currently push swap/commission per-position; we surface
      // null honestly rather than zero so the UI can omit the row.
      swap: null as number | null,
      commission: null as number | null,
      netProfit: floating,
      profitPercentOfSlot,
      openedAt: p.openedAt,
      lastUpdated: p.lastSyncedAt,
      freshness: cls.freshness,
      confirmation: cls.confirmation,
      // Margin honesty per row: forex = estimated; non-forex = unavailable
      // (broker doesn't report contract size; never fabricated).
      marginAvailable: forex,
      marginSource: (forex ? "ESTIMATED_FOREX" : "UNAVAILABLE") as "ESTIMATED_FOREX" | "UNAVAILABLE",
      _visible: visible,
    };
  });
  // Visible live set = everything except broker-confirmed-absent ghosts. Stale
  // rows stay visible (flagged confirmation-pending) while the snapshot is
  // unreliable; they are NOT hidden on stale timestamps alone.
  const positions = mapped.filter((m) => m._visible).map(({ _visible, ...rest }) => rest);
  const stalePositions = mapped.filter((m) => !m._visible).map(({ _visible, ...rest }) => rest);
  const lastSnapshotAt = lastSnapshotMs != null ? new Date(lastSnapshotMs).toISOString() : null;
  // Honest banner: open positions exist but the latest snapshot is unreliable,
  // so the broker view may still be settling. Required user-facing copy.
  const positionSyncIncomplete = !snapshotReliable && openPositions.length > 0;
  const snapshotWarning: string | null = positionSyncIncomplete ? POSITION_SYNC_INCOMPLETE_WARNING : null;

  const slotBalance = allocatedFunds + realisedPnl;
  const slotEquity = slotBalance + openPnL;
  const freeMargin = slotEquity - usedMargin;
  const marginLevelPercent = usedMargin > 0 ? (slotEquity / usedMargin) * 100 : null;

  // Task #451 — carry the canonical mark-to-market balance block (the SAME wire
  // shape the SSE stream sends as its `live` sibling, built from the same
  // server-side source via buildInvestorLiveBalanceSnapshot →
  // toInvestorLiveBalanceWire). When a backgrounded tab self-heals via the
  // one-shot poll, this lets the detailed balance breakdown (realized P/L,
  // available balance, floating P/L) heal to genuinely fresh/stale instead of
  // being honestly-but-needlessly downgraded to "unavailable". Per-user
  // isolation + honesty rules live inside the canonical builder.
  const live = toInvestorLiveBalanceWire(
    await buildInvestorLiveBalanceSnapshot(userId),
  );

  res.json({
    live,
    accountCurrency,
    balance: slotBalance,
    equity: slotEquity,
    margin: usedMargin,
    freeMargin,
    marginLevelPercent,
    // The EA does not push real per-position or account margin, so margin/
    // freeMargin are a forex-only estimate. marginEstimateIncomplete=true means
    // non-forex positions are held whose margin we deliberately do not fabricate.
    marginSource: "ESTIMATED" as const,
    marginEstimateIncomplete,
    openPnL,
    openPositionCount: positions.length,
    positions,
    stalePositions,
    stalePositionCount,
    lastSnapshotAt,
    dataFreshness: accountDataFreshness,
    // Position-snapshot reliability is distinct from bridge heartbeat: the book
    // is "pending broker confirmation" when no recent COMPLETE snapshot arrived.
    snapshotReliable,
    positionSyncIncomplete,
    snapshotWarning,
    isLive,
    isStale,
    isAllocated,
    allocationNote: isAllocated
      ? null
      : "No fund allocation assigned yet. An operator must allocate funds before live slot metrics will populate.",
    isFrozen,
    freezeMessage,
    aiSleeve,
    lastUpdated: new Date().toISOString(),
    readOnly: true,
    safetyMode: "phase_b_live_runtime_gated" as const,
  });
});

export default router;
