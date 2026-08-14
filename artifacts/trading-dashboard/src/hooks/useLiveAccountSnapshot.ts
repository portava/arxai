// useLiveAccountSnapshot — single shared truth source for live account data.
//
// DESIGN
//   SSE-first: connects to GET /api/me/live/account-stream. On stream drop
//   or when the tab is hidden, falls back to 5s polling against
//   GET /api/me/live/slot-summary (same DB scope, safe offline path).
//   The SSE stream re-establishes automatically when the tab regains focus
//   (exponential backoff: 2s → 4s → 8s → 16s → 30s cap).
//
// HONESTY RULES (mirror liveAccountSnapshot.ts on the server)
//   - A stale/unavailable value is NEVER relabelled "live". Freshness is
//     derived from the server's per-row timestamps, not from connection status.
//   - On fetch failure the hook holds its last known good snapshot; it does NOT
//     emit zeroes or fabricated numbers.
//   - All fields are nullable; the UI must guard every null before rendering.
//
// SAFETY: read-only. No dispatch, no execution-path side effects.
//   Per-user isolation lives on the server — the hook only forwards what the
//   authenticated session returns.

import { useEffect, useRef, useState, useCallback } from "react";

// ── Mirrored type definitions (kept in sync with liveAccountSnapshot.ts) ─────
export type AccountMode = "LIVE_SHARED" | "PAPER" | "DEMO" | "UNKNOWN";
export type Freshness = "live" | "fresh" | "delayed" | "stale" | "unavailable";
export type PlSource = "broker" | "computed" | "unavailable";

/**
 * Reconciliation marker — present on every live snapshot.  When
 * exceedsThreshold is true the summed position P/L materially disagrees with
 * the authoritative equity − balance and the UI must surface "P/L under
 * verification" rather than show the stale value as normal live profit.
 *
 * Kept in sync with SnapshotReconciliation in liveAccountSnapshot.ts on the
 * server.
 */
export interface SnapshotReconciliation {
  snapshotSummedPL: number | null;
  equityMinusBalancePL: number | null;
  discrepancy: number | null;
  exceedsThreshold: boolean;
  excludedCount: number;
  brokerAbsentExcludedCount: number;
  stalePLCount: number;
}

export interface LivePositionPL {
  positionId: string;
  brokerTicket?: string;
  symbol: string;
  direction: "buy" | "sell";
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  bid?: number;
  ask?: number;
  spread?: number;
  unrealizedPL: number | null;
  brokerPL?: number | null;
  computedPL?: number | null;
  plSource: PlSource;
  plIsEstimate: boolean;
  sl?: number | null;
  tp?: number | null;
  lastUpdateAtMs: number;
  freshness: Freshness;
}

/**
 * Task #430 — canonical mark-to-market balance block. This is the single
 * source of truth every balance surface (Dashboard, Open Trades, account,
 * risk panel, wallet, admin) reads, so they always agree on live equity.
 * floatingPnL is null when unavailable (never 0-faked). freshness.status
 * carries the canonical fresh|stale|unavailable verdict, so a stale figure is
 * never relabelled live.
 */
export interface InvestorLiveBalance {
  source: "live_shared" | "demo" | "paper" | "unknown";
  allocatedBalance: number;
  realizedPnL: number;
  floatingPnL: number | null;
  liveEquity: number;
  marginUsed: number;
  freeMargin: number;
  availableBalance: number;
  openTradeCount: number;
  freshness: { status: "fresh" | "stale" | "unavailable"; lastUpdatedAt: string | null; ageMs: number | null };
}

export interface LiveAccountSnapshot {
  userId: string;
  accountMode: AccountMode;
  /** Task #430 — canonical balance block (sibling of the SSE snapshot, merged in here). */
  live?: InvestorLiveBalance | null;
  source: "mt5" | "broker_snapshot" | "computed" | "fallback" | "unknown";
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  /** When the EA last delivered balance/equity (epoch ms), or null if never. */
  accountSyncedAtMs?: number | null;
  openPL: number | null;
  openPositionsCount: number;
  positions: LivePositionPL[];
  lastBrokerSnapshotAtMs?: number;
  lastQuoteUpdateAtMs?: number;
  lastComputedAtMs: number;
  freshness: Freshness;
  warnings: string[];
  /** Present when the server reports the user is not in live mode. */
  notLiveReason?: string;
  /** Reconciliation invariant — present on every live snapshot. */
  reconciliation?: SnapshotReconciliation;
}

// ── Connection status ─────────────────────────────────────────────────────────
export type ConnectionStatus = "connecting" | "live" | "polling" | "disconnected" | "unavailable";

export interface UseLiveAccountSnapshotResult {
  snapshot: LiveAccountSnapshot | null;
  /** Task #430 — canonical mark-to-market balance block. null until known. */
  live: InvestorLiveBalance | null;
  freshness: Freshness;
  connectionStatus: ConnectionStatus;
  lastUpdatedMs: number | null;
  notLiveReason: string | null;
  isEstimate: boolean;
  isStale: boolean;
  isUnavailable: boolean;
  warnings: string[];
  /** Force an immediate refresh (call after a mutation). */
  reload: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
const POLL_INTERVAL_MS = 5_000;

// Task #440 — when freshness flips to `stale`, proactively re-request the
// canonical snapshot instead of waiting for the next poll/SSE tick. Debounced
// so a burst of stale snapshots (e.g. the 3s SSE rebuild repeating a stale
// value) triggers at most one re-fetch, and only on the transition INTO stale
// (never in a loop while it stays stale). The honesty contract is unchanged:
// this only re-requests — it never optimistically clears the stale badge.
export const STALE_REFETCH_DEBOUNCE_MS = 2_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseSSEEvent(raw: unknown): LiveAccountSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["type"] === "account_snapshot" && r["snapshot"] && typeof r["snapshot"] === "object") {
    const snap = r["snapshot"] as LiveAccountSnapshot;
    // Task #430 — the canonical balance block rides as a sibling of `snapshot`.
    // Merge it onto the snapshot so all consumers read one object.
    if (r["live"] && typeof r["live"] === "object") {
      snap.live = r["live"] as InvestorLiveBalance;
    }
    return snap;
  }
  return null;
}

function isServerUnavailable(snap: LiveAccountSnapshot): boolean {
  return snap.accountMode === "UNKNOWN" && snap.freshness === "unavailable";
}

// ── Hook ──────────────────────────────────────────────────────────────────────
/**
 * Shared live account snapshot hook.  All surfaces — Dashboard, Open Trades,
 * Ruby panel — must use this hook so every surface always shows identical
 * numbers sourced from the same SSE stream / polling fallback.
 */
export function useLiveAccountSnapshot(): UseLiveAccountSnapshotResult {
  const [snapshot, setSnapshot] = useState<LiveAccountSnapshot | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [reloadAt, setReloadAt] = useState(0);

  // Refs to escape stale-closure issues in async callbacks.
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backoffIdxRef = useRef(0);
  const mountedRef = useRef(true);
  const snapRef = useRef<LiveAccountSnapshot | null>(null);
  // Task #440 — debounced auto-refresh when freshness flips to stale.
  const staleRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasStaleRef = useRef(false);

  // Keep snapRef in sync with state.
  useEffect(() => {
    snapRef.current = snapshot;
  }, [snapshot]);

  // ── Polling fallback ───────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current != null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Task #445 — `allowWhileHidden` lets the one-shot stale self-heal issue a
  // SINGLE proactive poll on a backgrounded tab, bypassing the hidden-tab perf
  // guard for that heal only. The recurring 5s interval still calls doPoll()
  // WITHOUT the flag, so the background poll loop stays paused (perf intact).
  const doPoll = useCallback(async (opts?: { allowWhileHidden?: boolean }) => {
    if (!mountedRef.current) return;
    if (document.hidden && !opts?.allowWhileHidden) return;
    try {
      const res = await fetch(u("/api/me/live/slot-summary"), { credentials: "include" });
      if (!mountedRef.current) return;
      if (!res.ok) { setConnectionStatus("disconnected"); return; }
      const data = await res.json() as Record<string, unknown>;
      if (!mountedRef.current) return;
      if (!data || typeof data !== "object") return;

      // slot-summary gives partial data — synthesize a LiveAccountSnapshot
      // using the EXACT field names the endpoint returns, falling back to the
      // last known SSE snapshot for fields slot-summary doesn't carry.
      //
      // Actual slot-summary response fields (meLiveAccount.ts):
      //   openPnL, openPositionCount, dataFreshness ("FRESH"/"STALE"/"MISSING"),
      //   balance, equity, margin, freeMargin, marginLevelPercent, isAllocated,
      //   isLive, allocationNote, positions[]
      // These differ from the SSE snapshot shape — map them carefully.
      const prev = snapRef.current;

      // Map "FRESH"/"STALE"/"MISSING" → Freshness enum.
      const rawFreshness = data["dataFreshness"];
      const freshness: Freshness =
        rawFreshness === "FRESH" ? "fresh" :
        rawFreshness === "STALE" ? "stale" : "unavailable";

      // Derive account mode from the server's own allocation/live flags rather
      // than hardcoding LIVE_SHARED. The SSE endpoint mode-gates via
      // getUserModeScope → resolveLivePositionVisibility; we mirror that truth
      // here using the same signals slot-summary already returns. A user who is
      // not allocated or not connected stays UNKNOWN so their data is never
      // mislabelled as live-shared.
      const isAllocated = Boolean(data["isAllocated"]);
      const isBridgeLive = Boolean(data["isLive"]);
      const accountMode: AccountMode = isAllocated && isBridgeLive ? "LIVE_SHARED" : "UNKNOWN";
      const notLiveReason: string | undefined =
        !isAllocated
          ? (data["allocationNote"] as string | undefined) ?? "No live allocation assigned."
          : !isBridgeLive
            ? "Bridge is not live or not connected."
            : undefined;

      // Task #451 — slot-summary now CARRIES the canonical balance block (the
      // same wire shape the SSE stream sends as its `live` sibling, built from
      // the same server-side source). So on a poll-based heal we rebuild the
      // detailed balance breakdown (realized P/L, available balance, floating
      // P/L) from the poll response itself and mark its freshness to match the
      // verified poll freshness (fresh/stale) — no longer downgrading to
      // "unavailable". This lets a backgrounded tab show the full live picture
      // without waiting to refocus. Honesty is preserved: the figures come from
      // the same re-verified poll, and freshness mirrors the poll's own verdict
      // so a stale poll yields a stale (never falsely-fresh) block.
      //
      // We force freshness.status to the poll's verdict (rather than trusting
      // the block's own server-computed status) so the detailed status can never
      // silently disagree with the headline `freshness`. When slot-summary
      // somehow omits the block we fall back to the last SSE-known block; when
      // the user is not LIVE_SHARED we leave the carried/polled block untouched.
      const polledLive =
        data["live"] && typeof data["live"] === "object"
          ? (data["live"] as InvestorLiveBalance)
          : null;
      const baseLive = polledLive ?? prev?.live ?? null;
      const balanceStatus: InvestorLiveBalance["freshness"]["status"] =
        freshness === "fresh" ? "fresh" : freshness === "stale" ? "stale" : "unavailable";
      const healedLive: InvestorLiveBalance | null =
        baseLive && accountMode === "LIVE_SHARED"
          ? { ...baseLive, freshness: { ...baseLive.freshness, status: balanceStatus } }
          : baseLive;

      const synth: LiveAccountSnapshot = {
        userId: prev?.userId ?? "",
        accountMode,
        live: healedLive,
        source: "computed",
        balance: (data["balance"] as number | null | undefined) ?? prev?.balance ?? null,
        equity: (data["equity"] as number | null | undefined) ?? prev?.equity ?? null,
        margin: (data["margin"] as number | null | undefined) ?? prev?.margin ?? null,
        freeMargin: (data["freeMargin"] as number | null | undefined) ?? prev?.freeMargin ?? null,
        marginLevel: (data["marginLevelPercent"] as number | null | undefined) ?? prev?.marginLevel ?? null,
        // slot-summary doesn't carry the account-sync marker; keep the last
        // SSE-known value so the >60s stale note stays honest across fallback.
        accountSyncedAtMs: prev?.accountSyncedAtMs ?? null,
        // Only forward financial figures when the user is actually in live-shared
        // mode — never surface a LIVE_SHARED-sourced number to a non-live user.
        openPL: accountMode === "LIVE_SHARED"
          ? ((data["openPnL"] as number | null | undefined) ?? prev?.openPL ?? null)
          : null,
        openPositionsCount: accountMode === "LIVE_SHARED"
          ? Number((data["openPositionCount"] as number | undefined) ?? prev?.openPositionsCount ?? 0)
          : 0,
        positions: accountMode === "LIVE_SHARED" ? (prev?.positions ?? []) : [],
        lastComputedAtMs: Date.now(),
        freshness: accountMode === "LIVE_SHARED" ? freshness : "unavailable",
        warnings: (data["snapshotWarning"] ? [String(data["snapshotWarning"])] : prev?.warnings) ?? [],
        notLiveReason,
      };
      setSnapshot(synth);
      setConnectionStatus("polling");
    } catch {
      if (mountedRef.current) setConnectionStatus("disconnected");
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    void doPoll();
    pollTimerRef.current = setInterval(() => { void doPoll(); }, POLL_INTERVAL_MS);
  }, [stopPolling, doPoll]);

  // ── SSE connection ─────────────────────────────────────────────────────────
  const stopSSE = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    if (reconnectTimerRef.current != null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connectSSE = useCallback(() => {
    if (esRef.current?.readyState === EventSource.OPEN) return;
    stopSSE();
    stopPolling();
    if (!mountedRef.current) return;

    setConnectionStatus("connecting");
    const es = new EventSource(u("/api/me/live/account-stream"), { withCredentials: true });
    esRef.current = es;

    es.addEventListener("message", (ev) => {
      if (!mountedRef.current) return;
      try {
        const raw: unknown = JSON.parse(ev.data as string);
        const r = raw as Record<string, unknown>;

        if (r["type"] === "heartbeat") {
          backoffIdxRef.current = 0;
          setConnectionStatus((prev) => prev === "connecting" ? "live" : prev);
          return;
        }
        if (r["type"] === "error_safe") {
          startPolling();
          return;
        }

        const parsed = parseSSEEvent(raw);
        if (parsed) {
          backoffIdxRef.current = 0;
          if (isServerUnavailable(parsed)) {
            setSnapshot(parsed);
            setConnectionStatus("unavailable");
          } else {
            setSnapshot(parsed);
            setConnectionStatus("live");
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      if (!mountedRef.current) return;
      es.close();
      esRef.current = null;
      setConnectionStatus("disconnected");
      startPolling();

      const delay = BACKOFF_MS[Math.min(backoffIdxRef.current, BACKOFF_MS.length - 1)]!;
      backoffIdxRef.current = Math.min(backoffIdxRef.current + 1, BACKOFF_MS.length - 1);

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current && !document.hidden) connectSSE();
      }, delay);
    };
  }, [stopSSE, stopPolling, startPolling]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    backoffIdxRef.current = 0;

    if (document.hidden) {
      setConnectionStatus("polling");
      startPolling();
    } else {
      connectSSE();
    }

    const onVis = () => {
      if (document.hidden) {
        stopSSE();
        startPolling();
      } else {
        stopPolling();
        backoffIdxRef.current = 0;
        connectSSE();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      mountedRef.current = false;
      stopSSE();
      stopPolling();
      document.removeEventListener("visibilitychange", onVis);
    };
    // reloadAt intentionally in deps to force re-mount on reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadAt]);

  const reload = useCallback(() => {
    backoffIdxRef.current = 0;
    setReloadAt(Date.now());
  }, []);

  // ── Task #440: auto-refresh on stale ───────────────────────────────────────
  // The moment freshness flips to `stale` (canonical balance block OR the
  // overall snapshot), proactively re-request the canonical snapshot so every
  // surface self-heals instead of waiting for the next interval. Debounced, and
  // fired only on the transition INTO stale so it never loops while the feed
  // stays stale. Re-requesting goes through reload() (SSE reconnect, which
  // pushes a fresh build immediately) when visible, or — Task #445 — a SINGLE
  // proactive poll when the tab is hidden (`allowWhileHidden: true` bypasses the
  // hidden-tab perf guard for this one-shot heal only). Because the self-heal
  // fires only on the transition INTO stale (wasStaleRef guard) and the recurring
  // 5s interval still honors the hidden-tab pause, a backgrounded tab issues AT
  // MOST ONE refresh — not a recurring loop. This never clears the stale badge
  // optimistically — the badge stays stale until genuinely fresh data arrives.
  useEffect(() => {
    const canonicalStale = snapshot?.live?.freshness.status === "stale";
    const snapStale = snapshot?.freshness === "stale";
    const isStaleNow = canonicalStale || snapStale;

    if (isStaleNow && !wasStaleRef.current && staleRefetchTimerRef.current == null) {
      staleRefetchTimerRef.current = setTimeout(() => {
        staleRefetchTimerRef.current = null;
        if (!mountedRef.current) return;
        if (document.hidden) void doPoll({ allowWhileHidden: true });
        else reload();
      }, STALE_REFETCH_DEBOUNCE_MS);
    }
    wasStaleRef.current = isStaleNow;
  }, [snapshot, doPoll, reload]);

  // Clear any pending stale-refetch timer on unmount.
  useEffect(() => () => {
    if (staleRefetchTimerRef.current != null) {
      clearTimeout(staleRefetchTimerRef.current);
      staleRefetchTimerRef.current = null;
    }
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const snap = snapshot;
  const freshness: Freshness = snap?.freshness ?? "unavailable";
  const notLiveReason = snap?.notLiveReason ?? (snap?.warnings.length ? snap.warnings[0]! : null);
  const isEstimate = snap?.positions.some((p) => p.plIsEstimate) ?? false;
  const isStale = freshness === "stale";
  const isUnavailable =
    freshness === "unavailable" || connectionStatus === "unavailable" || snap == null;
  const lastUpdatedMs = snap?.lastComputedAtMs ?? null;
  const warnings = snap?.warnings ?? [];

  return {
    snapshot: snap,
    live: snap?.live ?? null,
    freshness,
    connectionStatus,
    lastUpdatedMs,
    notLiveReason,
    isEstimate,
    isStale,
    isUnavailable,
    warnings,
    reload,
  };
}
