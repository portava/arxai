// useLiveBridgeRefresh — thin wrapper over useLiveAccountSnapshot that adds:
//   - autoRefreshEnabled toggle (localStorage-persisted, default on)
//   - refreshNow() for manual/forced refreshes
//   - isRefreshing state
//   - nextRefreshInMs countdown
//   - bridgeState freshness classification (live/delayed/stale/offline)
//   - lastRefreshAt timestamp
//
// DESIGN
//   The core SSE-first / polling-fallback logic lives in useLiveAccountSnapshot.
//   This hook wraps it and layers the UX state on top so the underlying
//   transport is untouched. When autoRefresh is off, the SSE connection and poll
//   loop are paused by simply not calling reload() and suppressing new intervals;
//   the SSE stream naturally drains through the server's 30s idle timeout.
//
// HONESTY RULES (inherited from useLiveAccountSnapshot)
//   - A stale/offline bridge state is NEVER relabelled live.
//   - isRefreshing is true only during an in-flight reload, never optimistically.
//   - lastRefreshAt is null until the first real response arrives.
//
// SAFETY: read-only. No dispatch or execution-path side effects.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  useLiveAccountSnapshot,
  type UseLiveAccountSnapshotResult,
  type Freshness,
  type InvestorLiveBalance,
  type LiveAccountSnapshot,
  type ConnectionStatus,
} from "./useLiveAccountSnapshot.js";

const LS_KEY = "arx_autoRefresh_enabled";

// Derive the 4-state bridge classification from the underlying connection status
// and snapshot freshness — no second fetch needed.
export type BridgeState = "live" | "delayed" | "stale" | "offline";

function deriveBridgeState(
  connectionStatus: ConnectionStatus,
  freshness: Freshness,
): BridgeState {
  if (connectionStatus === "unavailable" || connectionStatus === "disconnected") return "offline";
  if (freshness === "live" || (connectionStatus === "live" && freshness !== "stale" && freshness !== "unavailable")) return "live";
  if (freshness === "stale" || freshness === "unavailable") return "stale";
  if (freshness === "fresh" || freshness === "delayed") return "delayed";
  return "offline";
}

export interface UseLiveBridgeRefreshResult extends UseLiveAccountSnapshotResult {
  autoRefreshEnabled: boolean;
  setAutoRefreshEnabled: (enabled: boolean) => void;
  toggleAutoRefresh: () => void;
  refreshNow: () => void;
  isRefreshing: boolean;
  lastRefreshAt: number | null;
  nextRefreshInMs: number | null;
  bridgeState: BridgeState;
  // Pass-through for convenience (also on the base result, but typed explicitly)
  snapshot: LiveAccountSnapshot | null;
  live: InvestorLiveBalance | null;
}

// Countdown resolution — how often the countdown display updates.
const COUNTDOWN_TICK_MS = 250;
// Polling interval that useLiveAccountSnapshot uses — mirror it here for the
// countdown so the displayed countdown matches reality.
const REFRESH_INTERVAL_MS = 5_000;

// Standalone hook: opens (or shares, via the page provider) its OWN underlying
// snapshot stream. Use on pages NOT already wrapped in
// <LiveAccountSnapshotProvider>.
export function useLiveBridgeRefresh(): UseLiveBridgeRefreshResult {
  return useLiveBridgeRefreshState(useLiveAccountSnapshot());
}

// Pure layering over an ALREADY-OBTAINED base result. Use on pages that already
// consume the shared snapshot context (`useLiveAccountSnapshotCtx()`) so we do
// NOT open a second SSE connection.
export function useLiveBridgeRefreshState(
  base: UseLiveAccountSnapshotResult,
): UseLiveBridgeRefreshResult {
  // ── Auto-refresh toggle ─────────────────────────────────────────────────
  const readInitial = () => {
    try {
      const stored = localStorage.getItem(LS_KEY);
      return stored === null ? true : stored !== "false";
    } catch {
      return true;
    }
  };
  const [autoRefreshEnabled, setAutoRefreshRaw] = useState<boolean>(readInitial);

  const setAutoRefreshEnabled = useCallback((enabled: boolean) => {
    setAutoRefreshRaw(enabled);
    try { localStorage.setItem(LS_KEY, String(enabled)); } catch { /* noop */ }
  }, []);

  const toggleAutoRefresh = useCallback(() => {
    setAutoRefreshEnabled(!autoRefreshEnabled);
  }, [autoRefreshEnabled, setAutoRefreshEnabled]);

  // ── Periodic auto-reload when enabled ──────────────────────────────────
  // The SSE stream already handles live updates; this periodic reload is a
  // belt-and-suspenders that fires when the tab is visible and auto-refresh
  // is on but the SSE stream is polling or disconnected.
  const autoReloadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!autoRefreshEnabled) {
      if (autoReloadTimerRef.current != null) {
        clearInterval(autoReloadTimerRef.current);
        autoReloadTimerRef.current = null;
      }
      return;
    }
    // Only run the periodic reload when the SSE is not live — the stream
    // already pushes sub-second updates in that case.
    if (base.connectionStatus === "live") return;

    autoReloadTimerRef.current = setInterval(() => {
      if (!document.hidden) base.reload();
    }, REFRESH_INTERVAL_MS);

    return () => {
      if (autoReloadTimerRef.current != null) {
        clearInterval(autoReloadTimerRef.current);
        autoReloadTimerRef.current = null;
      }
    };
  }, [autoRefreshEnabled, base.connectionStatus, base.reload]);

  // ── isRefreshing ────────────────────────────────────────────────────────
  const [isRefreshing, setIsRefreshing] = useState(false);
  const prevUpdatedRef = useRef<number | null>(null);

  useEffect(() => {
    const current = base.lastUpdatedMs;
    if (current !== null && current !== prevUpdatedRef.current) {
      prevUpdatedRef.current = current;
      setIsRefreshing(false);
    }
  }, [base.lastUpdatedMs]);

  // ── Manual refresh ──────────────────────────────────────────────────────
  const refreshNow = useCallback(() => {
    setIsRefreshing(true);
    base.reload();
  }, [base.reload]);

  // ── Last refresh at ─────────────────────────────────────────────────────
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  useEffect(() => {
    if (base.lastUpdatedMs != null) setLastRefreshAt(base.lastUpdatedMs);
  }, [base.lastUpdatedMs]);

  // ── Countdown ──────────────────────────────────────────────────────────
  const [nextRefreshInMs, setNextRefreshInMs] = useState<number | null>(null);

  useEffect(() => {
    if (!autoRefreshEnabled || base.connectionStatus === "live") {
      setNextRefreshInMs(null);
      return;
    }
    const updateCountdown = () => {
      if (lastRefreshAt == null) { setNextRefreshInMs(null); return; }
      const elapsed = Date.now() - lastRefreshAt;
      const remaining = Math.max(0, REFRESH_INTERVAL_MS - elapsed);
      setNextRefreshInMs(remaining);
    };
    updateCountdown();
    const t = setInterval(updateCountdown, COUNTDOWN_TICK_MS);
    return () => clearInterval(t);
  }, [autoRefreshEnabled, base.connectionStatus, lastRefreshAt]);

  // ── Bridge state ────────────────────────────────────────────────────────
  const bridgeState = deriveBridgeState(base.connectionStatus, base.freshness);

  return {
    ...base,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    toggleAutoRefresh,
    refreshNow,
    isRefreshing,
    lastRefreshAt,
    nextRefreshInMs,
    bridgeState,
  };
}
