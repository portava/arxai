// The open P/L a USER_OWNED_MT5 card may show, from the trader's own bridge
// snapshot (applyOwnPositionSnapshot stores the broker's floating profit and
// stamps lastSyncedAt). Pure, so the route's rule is unit-testable.
//
// - No stored profit → unknown: unrealizedPnl null, waitingForSync true.
// - A stored profit whose observation is older than the bridge-online bound
//   (heartbeat policy: offline at 60 s; the EA pushes every ~5 s) or has no
//   observation time is stale → withheld the same way, never shown as current.
// - currentPrice is not part of the bridge push; it does not gate the P/L.

import { classifyHeartbeatAt } from "@workspace/domain/broker-health/heartbeatPolicy";

export interface OwnPositionPnlView {
  unrealizedPnl: number | null;
  waitingForSync: boolean;
  /** When the broker last reported this position (ISO), or null. */
  pnlObservedAt: string | null;
}

export function ownPositionPnlView(
  row: { unrealizedProfitLoss: number | null; lastSyncedAt: Date | null },
  nowMs: number,
): OwnPositionPnlView {
  const observedAt = row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null;
  const upnl = typeof row.unrealizedProfitLoss === "number" && Number.isFinite(row.unrealizedProfitLoss)
    ? row.unrealizedProfitLoss
    : null;
  const freshness = classifyHeartbeatAt(row.lastSyncedAt, nowMs);
  const current = freshness === "fresh" || freshness === "degraded";
  if (upnl == null || !current) return { unrealizedPnl: null, waitingForSync: true, pnlObservedAt: observedAt };
  return { unrealizedPnl: upnl, waitingForSync: false, pnlObservedAt: observedAt };
}
