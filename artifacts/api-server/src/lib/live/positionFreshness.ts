// Per-row open-position freshness classification (shared, pure).
//
// SAFETY / HONESTY — a stale `lastSyncedAt` on its own NEVER means a position
// closed. The EA pushes the broker's COMPLETE open-position list on each sync,
// so the rule is:
//   • A row refreshed inside the window = broker re-confirmed it open → FRESH.
//   • A stale/missing row is broker-confirmed ABSENT *only* when we ALSO have a
//     reliable recent snapshot that excluded it. If the latest snapshot itself
//     is stale/missing (bridge delayed, incomplete push, EA offline), we have
//     NO reliable broker truth and the position MUST stay visible — never
//     reconcile it out, hide it, or treat it as phantom on a stale timestamp
//     alone. This is what keeps real synthetic-index positions (V75/V25)
//     visible while an EA snapshot is merely lagging.
//
// This module is presentation-only. It never mutates rows and never auto-closes
// (auto-close is ALERT_ONLY). `closedAt` (set only on a broker-confirmed CLOSE
// command) remains the single authoritative "closed" signal.

export type Freshness = "FRESH" | "STALE" | "MISSING";
export type PositionConfirmation = "BROKER_CONFIRMED" | "BROKER_CONFIRMATION_PENDING";

// Exact user-facing copy required when the position snapshot is unreliable.
export const POSITION_SYNC_INCOMPLETE_WARNING =
  "Position sync incomplete — waiting for broker confirmation." as const;

// Per-row label shown when a position is visible but not yet re-confirmed by a
// fresh broker snapshot.
export const POSITION_PENDING_LABEL =
  "Live position — broker confirmation pending" as const;

/** Newest sync timestamp across rows (ms), or null when none have synced. */
export function newestSyncMs(syncTimes: Array<number | null>): number | null {
  let newest: number | null = null;
  for (const t of syncTimes) {
    if (t != null && (newest == null || t > newest)) newest = t;
  }
  return newest;
}

/**
 * Is the latest broker snapshot recent enough to be trusted as a COMPLETE
 * current picture? Only when this is true may a stale row be treated as
 * broker-confirmed-absent.
 *
 * `snapshotAtMs` MUST be the bridge's "complete sweep landed" marker
 * (`mt5_connection.last_positions_snapshot_at`), which the EA stamps on EVERY
 * positions ingest — INCLUDING an empty list (broker flat). It is deliberately
 * NOT derived from the newest row timestamp: when the broker goes flat there
 * are no rows to re-stamp, so a row-derived signal would (wrongly) decay to
 * "unreliable" and pin genuinely-closed rows on screen forever. The marker
 * keeps decaying only when the EA actually stops delivering sweeps (delayed /
 * offline), which is exactly when we must keep every open position visible.
 */
export function isSnapshotReliable(snapshotAtMs: number | null, windowMs: number, now: number): boolean {
  return snapshotAtMs != null && now - snapshotAtMs <= windowMs;
}

export interface RowFreshness {
  freshness: Freshness;
  confirmation: PositionConfirmation;
  // True ONLY when a reliable recent snapshot exists AND did not refresh this
  // row → the broker confirms it is no longer open (closed outside ARX), so it
  // is safe to drop from the default open view. False whenever the snapshot is
  // itself unreliable, so the position stays visible pending confirmation.
  brokerConfirmedAbsent: boolean;
}

export function classifyRow(
  syncMs: number | null,
  opts: { windowMs: number; now: number; snapshotReliable: boolean },
): RowFreshness {
  const { windowMs, now, snapshotReliable } = opts;
  const freshness: Freshness = syncMs == null
    ? "MISSING"
    : now - syncMs <= windowMs ? "FRESH" : "STALE";
  if (freshness === "FRESH") {
    return { freshness, confirmation: "BROKER_CONFIRMED", brokerConfirmedAbsent: false };
  }
  // Stale or missing row: only the presence of a reliable recent snapshot that
  // excluded it lets us conclude the broker no longer holds it.
  return {
    freshness,
    confirmation: "BROKER_CONFIRMATION_PENDING",
    brokerConfirmedAbsent: snapshotReliable,
  };
}
