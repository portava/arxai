// Presentation of the shared account transport. This layer owns no connection,
// polling interval or retry timer; the account hook owns pause and recovery.
import { useCallback } from "react";
import {
  useLiveAccountSnapshot,
  type UseLiveAccountSnapshotResult,
  type Freshness,
  type ConnectionStatus,
} from "./useLiveAccountSnapshot.js";

export type BridgeState = "live" | "delayed" | "stale" | "offline" | "paused";

function deriveBridgeState(connectionStatus: ConnectionStatus, freshness: Freshness): BridgeState {
  if (connectionStatus === "paused") return "paused";
  if (connectionStatus === "unavailable" || connectionStatus === "disconnected") return "offline";
  if (freshness === "stale" || freshness === "unavailable") return "stale";
  if (freshness === "live") return "live";
  // "fresh" and "delayed" (30 s – 2 min old) are delayed whatever the
  // connection says: a connected stream does not make old broker data current,
  // and only a snapshot the server calls live pulses "Live".
  if (freshness === "fresh" || freshness === "delayed") return "delayed";
  // A freshness value this client does not know is not evidence of anything.
  return "offline";
}

export interface UseLiveBridgeRefreshResult extends UseLiveAccountSnapshotResult {
  toggleAutoRefresh: () => void;
  refreshNow: () => void;
  lastRefreshAt: number | null;
  nextRefreshInMs: number | null;
  bridgeState: BridgeState;
}

/** Standalone reader. Pages with a provider use useLiveBridgeRefreshState. */
export function useLiveBridgeRefresh(): UseLiveBridgeRefreshResult {
  return useLiveBridgeRefreshState(useLiveAccountSnapshot());
}

export function useLiveBridgeRefreshState(base: UseLiveAccountSnapshotResult): UseLiveBridgeRefreshResult {
  const toggleAutoRefresh = useCallback(() => {
    base.setAutoRefreshEnabled(!base.autoRefreshEnabled);
  }, [base.autoRefreshEnabled, base.setAutoRefreshEnabled]);

  return {
    ...base,
    toggleAutoRefresh,
    refreshNow: base.reload,
    lastRefreshAt: base.lastUpdatedMs,
    // A snapshot's data timestamp is not the transport's next scheduled poll.
    // Do not fabricate a countdown from it, especially during backoff/pauses.
    nextRefreshInMs: null,
    bridgeState: deriveBridgeState(base.connectionStatus, base.freshness),
  };
}
