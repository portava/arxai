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

import { Router, type Request } from "express";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, mt5StateTable, mt5DemoCommandsTable, mt5ConnectionTable } from "@workspace/db";
import { arxLivePositionsTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { openLiveExposureCondition } from "../lib/live/livePositionExposure.js";
import {
  isSnapshotReliable,
  classifyRow,
  POSITION_SYNC_INCOMPLETE_WARNING,
} from "../lib/live/positionFreshness.js";
import { getUserModeScope, modeScopeEnvelope } from "../lib/modeScope/getUserModeScope.js";
import { resolveLivePositionVisibility } from "../lib/modeScope/livePositionVisibility.js";

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
  const isAdmin = role === "ADMIN" || role === "OWNER";
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
  const liveRowsAll = includeLive
    ? await db.select().from(arxLivePositionsTable)
        .where(openLiveExposureCondition(userId))
    : [];
  // Canonical freshness rule (lib/live/positionFreshness.ts) — shared verbatim
  // with /api/me/live/positions, the surface this feed claims one truth with.
  // A stale lastSyncedAt NEVER hides a row on its own: a stale/missing row is
  // dropped ONLY when a reliable recent snapshot excluded it (broker-confirmed
  // absent). The old relative "newest row − 90s" floor silently hid lagging
  // rows with no snapshot-reliability check and no warning, so the same open
  // broker position could show on OpenLivePositions (flagged "confirming…")
  // yet vanish from this picker — reading as closed/gone.
  const LIVE_STALE_MS = 90_000;
  const now = Date.now();
  // Reliability marker: the bridge's "complete sweep landed" stamp
  // (last_positions_snapshot_at) across the user's non-revoked, non-demo
  // bridges — the same query /api/me/live/positions runs.
  const snapMarkerRows = includeLive
    ? await db
        .select({ t: sql<string | null>`max(${mt5ConnectionTable.lastPositionsSnapshotAt})` })
        .from(mt5ConnectionTable)
        .where(and(
          eq(mt5ConnectionTable.userId, userId),
          ne(mt5ConnectionTable.status, "revoked"),
          or(isNull(mt5ConnectionTable.accountType), ne(mt5ConnectionTable.accountType, "demo")),
        ))
    : [];
  const snapshotAtMs = snapMarkerRows[0]?.t ? new Date(snapMarkerRows[0].t).getTime() : null;
  const snapshotReliable = isSnapshotReliable(snapshotAtMs, LIVE_STALE_MS, now);
  const classifyOf = (r: (typeof liveRowsAll)[number]) =>
    classifyRow(r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : null,
      { windowMs: LIVE_STALE_MS, now, snapshotReliable });
  const liveRows = liveRowsAll.filter((r) => {
    if (r.closedAt) return false;
    // Hide ONLY broker-confirmed-absent ghosts; stale rows stay visible
    // (confirmation pending) while the snapshot is unreliable.
    return !classifyOf(r).brokerConfirmedAbsent;
  });
  const live = liveRows.map((r) => ({
    scope: "live" as const,
    brokerTicket: r.brokerTicket,
    symbol: r.symbol,
    side: r.side,
    lotSize: Number(r.volume),
    entryPrice: Number(r.entryPrice),
    currentPrice: r.currentPrice != null ? Number(r.currentPrice) : null,
    stopLoss: r.stopLoss != null ? Number(r.stopLoss) : null,
    takeProfit: r.takeProfit != null ? Number(r.takeProfit) : null,
    floatingPnl: r.floatingPl != null ? Number(r.floatingPl) : null,
    // When this row's prices/P&L were last confirmed by the EA bridge (ISO),
    // or null when never synced. Lets clients label a stale floating P/L
    // honestly ("as of Xm ago") instead of rendering it as a live number.
    lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString() : null,
    openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : String(r.openedAt ?? ""),
    sourceCommandId: r.sourceCommandId ?? null,
    accountMode: "LIVE" as const,
    source: "MT5_LIVE_BRIDGE" as const,
    // Per-row honesty, same tokens as /api/me/live/positions: STALE/MISSING
    // rows are kept visible and flagged pending broker confirmation.
    freshness: classifyOf(r).freshness,
    confirmation: classifyOf(r).confirmation,
  }));

  // DEMO — pull latest mt5_state row for this user, then map positions.
  // Skipped entirely when mode is not DEMO so a LIVE_SHARED user never
  // sees their old demo positions bleed into the unified feed.
  const stateRows = includeDemo
    ? await db.select().from(mt5StateTable)
        .where(eq(mt5StateTable.userId, userId))
        .orderBy(sql`${mt5StateTable.lastSyncAt} DESC NULLS LAST`)
        .limit(1)
    : [];
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

  const demo = positionsRaw.map((p) => {
    const ticket = p.ticket == null ? null : String(p.ticket);
    const matched = ticket ? byTicket.get(ticket) ?? null : null;
    return {
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

  // Shared honest banner: live rows exist but the latest EA snapshot is
  // unreliable, so the open book may not match the broker yet. Same copy the
  // sibling live surfaces emit.
  const snapshotWarning: string | null =
    includeLive && !snapshotReliable && live.length > 0 ? POSITION_SYNC_INCOMPLETE_WARNING : null;

  res.json({
    ok: true,
    live, demo,
    liveCount: live.length, demoCount: demo.length,
    snapshotWarning,
    snapshotReliable,
    notLiveReason,
    ...modeScopeEnvelope(scope),
  });
});

export default router;
