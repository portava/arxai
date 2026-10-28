// Unified per-user positions feed for the Position-on-Chart side card.
//
// GET /api/me/positions/all
//   → { live: [...], demo: [...] }   strictly scoped to req.user.id.
//
// SAFETY:
//  - requireUser middleware enforces auth.
//  - Live rows are filtered by userId on arx_live_positions.
//  - Demo rows are filtered by userId on mt5_state + mt5_demo_commands.
//  - No bridge tokens, no hashed-key blobs, no IPs, no account numbers leak.
//  - Read-only. Cannot place / modify / close any trade.
//
// AUDIT:
//  - Emits POSITION_SELECTED on every read (via req.log) so we have an
//    append-only trail of when each user viewed their open positions.

import { readOpenPositions } from "../lib/positions/openPositions.js";
import { Router, type Request } from "express";
import { desc, eq } from "drizzle-orm";
import { db, mt5DemoCommandsTable } from "@workspace/db";

import { requireUser } from "../lib/auth/middleware.js";
import { getUserModeScope, modeScopeEnvelope } from "../lib/modeScope/getUserModeScope.js";
import { resolveLivePositionVisibility } from "../lib/modeScope/livePositionVisibility.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";
import { readLatestUserMt5State } from "../lib/brokerHub/mt5StateReader.js";

const router = Router();

function uid(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number | string } }).authUser;
  const id = u?.id;
  if (id == null) return null;
  const n = typeof id === "number" ? id : Number(id);
  return Number.isFinite(n) ? n : null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Absolute per-row freshness. The relative stale-floor below only drops rows
// that lag the NEWEST row, so when the whole bridge goes quiet every row still
// passes it; each row therefore also carries when the bridge last reported it
// and whether that is recent. The EA pushes a complete snapshot every ~5s, so
// 30s matches the slot-summary snapshot window.
export const UNIFIED_POSITION_FRESH_MS = 30_000;
export type UnifiedPositionFreshness = "FRESH" | "STALE" | "MISSING";

export function unifiedPositionFreshness(observedAt: Date | string | null | undefined, now = Date.now()): {
  observedAt: string | null;
  freshness: UnifiedPositionFreshness;
} {
  if (observedAt == null) return { observedAt: null, freshness: "MISSING" };
  const d = observedAt instanceof Date ? observedAt : new Date(observedAt);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return { observedAt: null, freshness: "MISSING" };
  return {
    observedAt: d.toISOString(),
    freshness: now - ms <= UNIFIED_POSITION_FRESH_MS ? "FRESH" : "STALE",
  };
}

type DemoRaw = {
  ticket?: string | number | null;
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  lot?: number | null;
  volume?: number | null;
  openPrice?: number | null;
  currentPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  profit?: number | null;
  openTime?: string | null;
};

router.get("/me/positions/all", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  // Mode-scope: a LIVE_SHARED user must NEVER see DEMO rows in their
  // unified positions feed (and vice versa). A PAPER user sees nothing
  // here at all — paper rows live on the paper trades feed.
  const role = (req as Request & { authUser?: { role?: string } }).authUser?.role;
  const isAdmin = operatorRoleFromSession(role) != null;
  const scope = await getUserModeScope(userId, { isAdmin });
  // Canonical live-position visibility — shared verbatim with
  // /api/me/live/positions so one real broker position can never produce two
  // different user-facing truths across ARX. notLiveReason is the same token
  // both surfaces emit; the frontend maps it to user-safe copy.
  const { includeLive, notLiveReason } = resolveLivePositionVisibility(scope.currentAccountMode);
  const includeDemo = scope.currentAccountMode === "DEMO";

  // LIVE — arx_live_positions, scoped by userId AND by mode.
  // Open-exposure predicate (shared truth): exclude rows that are closed OR
  // carry any reconcile_state (RECONCILED_BROKER_ABSENT / IGNORED / EXTERNAL /
  // IMPORTED). A reconciled ghost is broker-confirmed gone and must never count
  // as an open position here — without this filter a reconciled row whose
  // closed_at was never stamped (orphan IGNORE) would re-surface, and stamping
  // closed_at on phantoms would shift the relative stale-floor below so the
  // remaining reconciled rows passed it. Ghost reconcile (stale-floor) below
  // stays as defense-in-depth for not-yet-reconciled stale rows.
  // The canonical open-position read model applies the same exposure predicate
  // (openLiveExposureCondition) and the same LIVE_SHARED-only mode rule.
  const liveRowsAll = includeLive
    ? await readOpenPositions({ userId, venue: "LIVE", basis: "EXPOSURE", modeScope: scope })
    : [];
  const LIVE_STALE_MS = 90_000;
  const newestLiveSync = liveRowsAll.reduce((max, r) => {
    const t = r.observedAt ? new Date(r.observedAt).getTime() : 0;
    return t > max ? t : max;
  }, 0);
  const liveFloor = newestLiveSync > 0 ? newestLiveSync - LIVE_STALE_MS : 0;
  const liveRows = liveRowsAll.filter((r) => {
    if (r.row.closedAt) return false;
    const t = r.observedAt ? new Date(r.observedAt).getTime() : 0;
    return t >= liveFloor;
  });
  const nowMs = Date.now();
  const live = liveRows.map((r) => ({
    ...unifiedPositionFreshness(r.observedAt, nowMs),
    scope: "live" as const,
    brokerTicket: r.ticket,
    symbol: r.symbol,
    side: r.side,
    lotSize: Number(r.lots),
    entryPrice: Number(r.entryPrice),
    currentPrice: r.currentPrice != null ? Number(r.currentPrice) : null,
    stopLoss: r.stopLoss != null ? Number(r.stopLoss) : null,
    takeProfit: r.takeProfit != null ? Number(r.takeProfit) : null,
    floatingPnl: r.floatingPnl != null ? Number(r.floatingPnl) : null,
    openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : String(r.openedAt ?? ""),
    sourceCommandId: r.sourceCommandId ?? null,
    accountMode: "LIVE" as const,
    source: "MT5_LIVE_BRIDGE" as const,
  }));

  // DEMO — pull latest mt5_state row for this user, then map positions.
  // Skipped entirely when mode is not DEMO so a LIVE_SHARED user never
  // sees their old demo positions bleed into the unified feed.
  const demoState = includeDemo ? await readLatestUserMt5State(userId) : null;
  const stateRows = demoState ? [demoState] : [];
  const positionsRaw: DemoRaw[] = Array.isArray(stateRows[0]?.positions)
    ? (stateRows[0]!.positions as DemoRaw[]) : [];

  // Recent demo commands → resolve sourceCommandId per ticket.
  const cmdRows = positionsRaw.length === 0 ? [] : await db.select({
    commandId: mt5DemoCommandsTable.commandId,
    brokerTicket: mt5DemoCommandsTable.brokerTicket,
    sourcePage: mt5DemoCommandsTable.sourcePage,
  }).from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.userId, userId))
    .orderBy(desc(mt5DemoCommandsTable.id))
    .limit(100);
  const byTicket = new Map<string, typeof cmdRows[number]>();
  for (const c of cmdRows) if (c.brokerTicket) byTicket.set(String(c.brokerTicket), c);

  // Demo rows come from one mt5_state snapshot; its lastSyncAt is when the
  // bridge last reported all of them.
  const demoObserved = unifiedPositionFreshness(demoState?.lastSyncAt ?? null, nowMs);
  const demo = positionsRaw.map((p) => {
    const ticket = p.ticket == null ? null : String(p.ticket);
    const matched = ticket ? byTicket.get(ticket) ?? null : null;
    return {
      ...demoObserved,
      scope: "demo" as const,
      brokerTicket: ticket,
      symbol: p.symbol ?? null,
      side: p.side ?? null,
      lotSize: num(p.lot ?? p.volume),
      entryPrice: num(p.openPrice),
      currentPrice: num(p.currentPrice),
      stopLoss: num(p.stopLoss),
      takeProfit: num(p.takeProfit),
      floatingPnl: num(p.profit),
      openedAt: p.openTime ?? null,
      sourceCommandId: matched?.commandId ?? null,
      accountMode: "DEMO" as const,
      source: matched?.sourcePage ?? "MT5_DEMO_BRIDGE",
    };
  });

  req.log.info({
    action: "POSITION_SELECTED",
    userId, liveCount: live.length, demoCount: demo.length,
    currentAccountMode: scope.currentAccountMode,
  }, "positions.unified.read");

  res.json({
    ok: true,
    live, demo,
    liveCount: live.length, demoCount: demo.length,
    notLiveReason,
    ...modeScopeEnvelope(scope),
  });
});

export default router;
