// /mt5/status for a user with no MT5 connection of their own.
//
// A user routed through the shared master (accountRoutingMode
// SHARED_MASTER_MT5) trades via the master bridge, not a personal
// mt5_connection. /mt5/status only reads the user's own connection, so such a
// user was told "the shared MT5 bridge is not connected" while the master was
// heartbeating. This reads the shared master bridge for them — the same
// per-user allocation view the live gate uses (getUserAllocationView) — and
// re-ages its snapshot NOW, so a pool row computed minutes ago is never
// presented as a current HEALTHY bridge.
//
// Read-only. Never exposes master credentials or account numbers.

import { MT5_ACCOUNT_SNAPSHOT_FRESH_MS } from "../lib/brokerHub/freshness.js";

export type SharedBridgeAvailability = "HEALTHY" | "RECONCILING" | "UNAVAILABLE" | "STALE" | "UNKNOWN";

export interface SharedMasterBridgeStatus {
  /** HEALTHY only when the allocation view says so AND the master snapshot is fresh now. */
  availability: SharedBridgeAvailability;
  connected: boolean;
  message: string;
  lastSnapshotAt: string | null;
  snapshotAgeSeconds: number | null;
  source: "shared_master_bridge_pool";
}

export type Mt5StatusRoute = "OWN_CONNECTION" | "SHARED_MASTER" | "NONE";

export interface SharedBridgeDeps {
  getEnvelope: (userId: number) => Promise<{ accountRoutingMode: string }>;
  getUserAllocationView: (userId: number) => Promise<{
    pool: { lastMt5SnapshotAt: Date | string | null } | null;
    bridgeAvailability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE";
    bridgeMessage: string;
  }>;
  now?: () => number;
}

async function defaultDeps(): Promise<SharedBridgeDeps> {
  const [{ getEnvelope }, { getUserAllocationView }] = await Promise.all([
    import("../lib/adminTrading/safetyEnvelope.js"),
    import("../lib/live/masterBridgePool.js"),
  ]);
  return { getEnvelope, getUserAllocationView };
}

/**
 * For a user with no own connection: whether they route through the shared
 * master and, if so, what the master bridge looks like right now. A read
 * failure is UNKNOWN (never connected).
 */
export async function readSharedMasterBridgeForUser(
  userId: number,
  deps?: SharedBridgeDeps,
): Promise<{ route: Mt5StatusRoute; sharedMasterBridge: SharedMasterBridgeStatus | null }> {
  const d = deps ?? await defaultDeps();
  const now = (d.now ?? Date.now)();
  let routing: string;
  try {
    routing = (await d.getEnvelope(userId)).accountRoutingMode;
  } catch {
    return {
      route: "NONE",
      sharedMasterBridge: null,
    };
  }
  if (routing !== "SHARED_MASTER_MT5") return { route: "NONE", sharedMasterBridge: null };

  try {
    const view = await d.getUserAllocationView(userId);
    const at = view.pool?.lastMt5SnapshotAt ? new Date(view.pool.lastMt5SnapshotAt) : null;
    const atMs = at && Number.isFinite(at.getTime()) ? at.getTime() : null;
    const ageMs = atMs != null ? Math.max(0, now - atMs) : null;
    const fresh = ageMs != null && ageMs <= MT5_ACCOUNT_SNAPSHOT_FRESH_MS;
    let availability: SharedBridgeAvailability = view.bridgeAvailability;
    let message = view.bridgeMessage;
    if (availability === "HEALTHY" && !fresh) {
      availability = "STALE";
      message = ageMs == null
        ? "Shared MT5 bridge has not reported a snapshot."
        : `Shared MT5 bridge last reported ${Math.floor(ageMs / 1000)}s ago — too old to count as connected.`;
    }
    return {
      route: "SHARED_MASTER",
      sharedMasterBridge: {
        availability,
        connected: availability === "HEALTHY",
        message,
        lastSnapshotAt: atMs != null ? new Date(atMs).toISOString() : null,
        snapshotAgeSeconds: ageMs != null ? Math.floor(ageMs / 1000) : null,
        source: "shared_master_bridge_pool",
      },
    };
  } catch {
    return {
      route: "SHARED_MASTER",
      sharedMasterBridge: {
        availability: "UNKNOWN", connected: false,
        message: "Shared MT5 bridge status could not be read.",
        lastSnapshotAt: null, snapshotAgeSeconds: null, source: "shared_master_bridge_pool",
      },
    };
  }
}
