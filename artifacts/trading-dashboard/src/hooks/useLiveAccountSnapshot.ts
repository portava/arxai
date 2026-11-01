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

import { useEffect, useRef, useState, useCallback, useContext, useMemo } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { createSharedAccountChangeRefresh, createPersonalAccountChangeRefresh } from "./sharedAccountChangeRefresh";
import { useAgedAccountSnapshot } from "./useAgedAccountSnapshot";
import { useAccountRefreshPreference } from "./useAccountRefreshPreference";

// ── Mirrored type definitions (kept in sync with liveAccountSnapshot.ts) ─────
export type AccountMode = "LIVE_SHARED" | "PAPER" | "DEMO" | "UNKNOWN";
export type Freshness = "live" | "fresh" | "delayed" | "stale" | "unavailable";
export type PlSource = "broker" | "computed" | "unavailable";

/** Supplied-position diagnostics, not a verified native account-profit report.
 * A false exceedsThreshold never establishes agreement. */
export interface SnapshotReconciliation {
  status?: "unverified";
  reason?: "NO_MATCHED_ACCOUNT_PROFIT_REPORT";
  positionPnlScope?: "supplied_rows";
  positionPnlComplete?: boolean;
  snapshotSummedPL: number | null;
  /** Legacy name: balance/equity arithmetic only, never broker profit. */
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
  /** Display scope/completeness; not a new balance or execution authority. */
  valueScope?: "arx_allocation";
  positionPnlComplete?: boolean;
  positionPnlEstimated?: boolean;
  monetaryScopeVerified?: boolean;
  realizedPnLPendingCount?: number;
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
  /** Client fallback polls carry funds/counts, never a complete position list. */
  positionsComplete?: boolean;
  positionCountKnown?: boolean;
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
export type ConnectionStatus = "connecting" | "live" | "polling" | "disconnected" | "unavailable" | "paused";

export interface UseLiveAccountSnapshotResult {
  autoRefreshEnabled: boolean;
  setAutoRefreshEnabled: (enabled: boolean) => void;
  isRefreshing: boolean;
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
const POLL_TIMEOUT_MS = 10_000;

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
  // Snapshot-only consumers may be standalone; dashboard consumers share the
  // application QueryClient with both master-account cards.
  const queryClient = useContext(QueryClientContext);
  const sharedAccountRefreshRef = useRef<ReturnType<typeof createSharedAccountChangeRefresh> | null>(null);
  const personalAccountRefreshRef = useRef<ReturnType<typeof createPersonalAccountChangeRefresh> | null>(null);
  const [snapshot, setSnapshot] = useState<LiveAccountSnapshot | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [reloadAt, setReloadAt] = useState(0);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useAccountRefreshPreference();
  const enabledRef = useRef(autoRefreshEnabled);
  enabledRef.current = autoRefreshEnabled;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const streamWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs to escape stale-closure issues in async callbacks.
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRequestRef = useRef<AbortController | null>(null);
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
    pollRequestRef.current?.abort();
    pollRequestRef.current = null;
    setIsRefreshing(false);
  }, []);

  // Task #445 — `allowWhileHidden` lets the one-shot stale self-heal issue a
  // SINGLE proactive poll on a backgrounded tab, bypassing the hidden-tab perf
  // guard for that heal only. The recurring 5s interval still calls doPoll()
  // WITHOUT the flag, so the background poll loop stays paused (perf intact).
  const doPoll = useCallback(async (opts?: { allowWhileHidden?: boolean; manual?: boolean }) => {
    if (!mountedRef.current || (!enabledRef.current && !opts?.manual)) return;
    if (document.hidden && !opts?.allowWhileHidden) return;
    if (pollRequestRef.current) return;
    const request = new AbortController();
    pollRequestRef.current = request;
    setIsRefreshing(true);
    const current = () => mountedRef.current && pollRequestRef.current === request && !request.signal.aborted;
    const timeout = setTimeout(() => {
      if (!current()) return;
      request.abort();
      pollRequestRef.current = null;
      setConnectionStatus(enabledRef.current ? "disconnected" : "paused");
      setIsRefreshing(false);
    }, POLL_TIMEOUT_MS);
    request.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      const res = await fetch(u("/api/me/live/slot-summary"), { credentials: "include", signal: request.signal });
      if (!current()) return;
      if (!res.ok) { setConnectionStatus(enabledRef.current ? "disconnected" : "paused"); return; }
      const data = await res.json() as Record<string, unknown>;
      if (!current()) return;
      if (!data || typeof data !== "object") return;

      // slot-summary gives partial data — synthesize a LiveAccountSnapshot
      // using the EXACT field names the endpoint returns. A successful response
      // stands on its own: absent/null amounts must not refresh previous amounts.
      // Request failure preserves the previous snapshot and its original age.
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
      const isAllocated = data["isAllocated"] === true;
      const isBridgeLive = data["isLive"] === true;
      const accountMode: AccountMode = isAllocated && isBridgeLive ? "LIVE_SHARED" : "UNKNOWN";
      const notLiveReason: string | undefined =
        !isAllocated
          ? (data["allocationNote"] as string | undefined) ?? "No live allocation assigned."
          : !isBridgeLive
            ? "Bridge is not live or not connected."
            : undefined;

      // Heartbeat freshness and balance freshness measure different evidence.
      // A successful poll must never promote stale/unknown canonical funds.
      const polledLive =
        data["live"] && typeof data["live"] === "object"
          ? (data["live"] as InvestorLiveBalance)
          : null;
      let healedLive: InvestorLiveBalance | null = null;
      if (accountMode === "LIVE_SHARED") {
        // Explicit null invalidates the block. Older endpoints may omit it:
        // preserve only same-mode last-known evidence, marked stale below.
        const baseLive = data["live"] !== undefined
          ? polledLive
          : prev?.accountMode === "LIVE_SHARED" ? prev.live ?? null : null;
        if (baseLive) {
          const canonical = baseLive.freshness.status;
          const status = canonical === "unavailable" || freshness === "unavailable"
            ? "unavailable"
            : canonical === "stale" || freshness !== "fresh" || !polledLive
              ? "stale" : "fresh";
          healedLive = { ...baseLive, freshness: { ...baseLive.freshness, status } };
        }
      }

      const amount = (field: string): number | null => {
        const value = data[field];
        return accountMode === "LIVE_SHARED" && typeof value === "number" && Number.isFinite(value) ? value : null;
      };
      const count = data["openPositionCount"];
      const positionCountKnown = accountMode === "LIVE_SHARED" && typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
      const synth: LiveAccountSnapshot = {
        userId: prev?.userId ?? "",
        accountMode,
        live: healedLive,
        source: "computed",
        balance: amount("balance"),
        equity: amount("equity"),
        margin: amount("margin"),
        freeMargin: amount("freeMargin"),
        marginLevel: amount("marginLevelPercent"),
        // slot-summary doesn't carry the account-sync marker; keep the last
        // SSE-known value so the >60s stale note stays honest across fallback.
        accountSyncedAtMs: accountMode === "LIVE_SHARED" && prev?.accountMode === "LIVE_SHARED" ? prev.accountSyncedAtMs ?? null : null,
        // Only forward financial figures when the user is actually in live-shared
        // mode — never surface a LIVE_SHARED-sourced number to a non-live user.
        openPL: amount("openPnL"),
        // Legacy numeric shape remains; display consumers must honor unknown metadata.
        openPositionsCount: positionCountKnown ? count as number : 0,
        positions: accountMode === "LIVE_SHARED" && prev?.accountMode === "LIVE_SHARED" ? prev.positions : [],
        positionsComplete: false,
        positionCountKnown,
        lastComputedAtMs: Date.now(),
        freshness: accountMode === "LIVE_SHARED" ? freshness : "unavailable",
        warnings: (data["snapshotWarning"] ? [String(data["snapshotWarning"])] : prev?.warnings) ?? [],
        notLiveReason,
      };
      snapRef.current = synth;
      setSnapshot(synth);
      setConnectionStatus(enabledRef.current ? "polling" : "paused");
    } catch {
      if (current()) setConnectionStatus(enabledRef.current ? "disconnected" : "paused");
    } finally {
      clearTimeout(timeout);
      if (pollRequestRef.current === request) {
        pollRequestRef.current = null;
        setIsRefreshing(false);
      }
    }
  }, []);

  const startPolling = useCallback(() => {
    if (!enabledRef.current || pollTimerRef.current != null) return;
    void doPoll();
    pollTimerRef.current = setInterval(() => { void doPoll(); }, POLL_INTERVAL_MS);
  }, [doPoll]);

  // ── SSE connection ─────────────────────────────────────────────────────────
  const stopSSE = useCallback(() => {
    sharedAccountRefreshRef.current?.dispose();
    sharedAccountRefreshRef.current = null;
    personalAccountRefreshRef.current?.dispose();
    personalAccountRefreshRef.current = null;
    if (streamWaitRef.current != null) { clearTimeout(streamWaitRef.current); streamWaitRef.current = null; }
    setIsRefreshing(false);
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    if (reconnectTimerRef.current != null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connectSSE = useCallback(() => {
    if (esRef.current?.readyState === EventSource.OPEN) return;
    stopSSE();
    // Keep fallback reads alive until the replacement stream actually delivers
    // a snapshot; reconnecting alone is not evidence of recovery.
    if (!mountedRef.current || !enabledRef.current) return;

    setConnectionStatus("connecting");
    setIsRefreshing(true);
    const es = new EventSource(u("/api/me/live/account-stream"), { withCredentials: true });
    esRef.current = es;
    sharedAccountRefreshRef.current = queryClient ? createSharedAccountChangeRefresh(queryClient) : null;
    personalAccountRefreshRef.current = queryClient ? createPersonalAccountChangeRefresh(queryClient) : null;
    // A socket that stays open without delivering data must not disable the
    // refresh button forever. Keep it eligible to recover while polling.
    streamWaitRef.current = setTimeout(() => {
      streamWaitRef.current = null;
      if (mountedRef.current && esRef.current === es && enabledRef.current) startPolling();
    }, POLL_TIMEOUT_MS);

    es.addEventListener("message", (ev) => {
      if (!mountedRef.current || esRef.current !== es) return;
      try {
        const raw: unknown = JSON.parse(ev.data as string);
        const r = raw as Record<string, unknown>;

        if (r["type"] === "shared_account_changed" || r["type"] === "personal_account_changed") {
          if (enabledRef.current && !document.hidden) {
            const refresh = r["type"] === "personal_account_changed" ? personalAccountRefreshRef : sharedAccountRefreshRef;
            refresh.current?.notify();
          }
          // Advisory only: do not renew freshness, change money, or treat this
          // as an account snapshot that can stop fallback reads.
          return;
        }
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
          // A confirmed stream snapshot supersedes any older fallback request.
          // Abort it and reject even a response already decoding its JSON.
          stopPolling();
          if (streamWaitRef.current != null) { clearTimeout(streamWaitRef.current); streamWaitRef.current = null; }
          backoffIdxRef.current = 0;
          snapRef.current = parsed;
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
      if (!mountedRef.current || esRef.current !== es) return;
      sharedAccountRefreshRef.current?.dispose();
      sharedAccountRefreshRef.current = null;
      personalAccountRefreshRef.current?.dispose();
      personalAccountRefreshRef.current = null;
      es.close();
      esRef.current = null;
      if (streamWaitRef.current != null) { clearTimeout(streamWaitRef.current); streamWaitRef.current = null; }
      setConnectionStatus("disconnected");
      startPolling();

      const delay = BACKOFF_MS[Math.min(backoffIdxRef.current, BACKOFF_MS.length - 1)]!;
      backoffIdxRef.current = Math.min(backoffIdxRef.current + 1, BACKOFF_MS.length - 1);

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current && enabledRef.current && !document.hidden) connectSSE();
      }, delay);
    };
  }, [stopSSE, stopPolling, startPolling, queryClient]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    backoffIdxRef.current = 0;

    if (!autoRefreshEnabled) {
      setConnectionStatus("paused");
      setIsRefreshing(false);
    } else if (document.hidden) {
      setConnectionStatus("polling");
      startPolling();
    } else {
      connectSSE();
    }

    const onVis = () => {
      if (!enabledRef.current) return;
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
  }, [reloadAt, autoRefreshEnabled, queryClient]);

  const reload = useCallback(() => {
    backoffIdxRef.current = 0;
    if (enabledRef.current) setReloadAt(value => value + 1);
    else void doPoll({ manual: true, allowWhileHidden: true });
  }, [doPoll]);

  const agedSnapshot = useAgedAccountSnapshot(snapshot);

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
    if (!autoRefreshEnabled) {
      if (staleRefetchTimerRef.current != null) clearTimeout(staleRefetchTimerRef.current);
      staleRefetchTimerRef.current = null;
      return;
    }
    const canonicalStale = agedSnapshot?.live?.freshness.status === "stale";
    const snapStale = agedSnapshot?.freshness === "stale";
    const isStaleNow = canonicalStale || snapStale;

    if (!isStaleNow && staleRefetchTimerRef.current != null) {
      clearTimeout(staleRefetchTimerRef.current);
      staleRefetchTimerRef.current = null;
    }

    if (isStaleNow && !wasStaleRef.current && staleRefetchTimerRef.current == null) {
      staleRefetchTimerRef.current = setTimeout(() => {
        staleRefetchTimerRef.current = null;
        if (!mountedRef.current || !enabledRef.current) return;
        if (document.hidden) void doPoll({ allowWhileHidden: true });
        else reload();
      }, STALE_REFETCH_DEBOUNCE_MS);
    }
    wasStaleRef.current = isStaleNow;
  }, [agedSnapshot, doPoll, reload, autoRefreshEnabled]);

  // Clear any pending stale-refetch timer on unmount.
  useEffect(() => () => {
    if (staleRefetchTimerRef.current != null) {
      clearTimeout(staleRefetchTimerRef.current);
      staleRefetchTimerRef.current = null;
    }
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  // Missing legacy completeness cannot turn a subtotal into an account total.
  // Preserve every real position value; this is aggregate display sanitation.
  const snap = useMemo(() => agedSnapshot == null ? null : {
    ...agedSnapshot,
    openPL: agedSnapshot.reconciliation?.positionPnlComplete === true
      && typeof agedSnapshot.openPL === "number" && Number.isFinite(agedSnapshot.openPL)
      ? agedSnapshot.openPL : null,
  }, [agedSnapshot]);
  const freshness: Freshness = snap?.freshness ?? "unavailable";
  const notLiveReason = snap?.notLiveReason ?? (snap?.warnings.length ? snap.warnings[0]! : null);
  const isEstimate = snap?.positions.some((p) => p.plIsEstimate) ?? false;
  const isStale = freshness === "stale";
  const isUnavailable =
    freshness === "unavailable" || connectionStatus === "unavailable" || snap == null;
  const lastUpdatedMs = snap?.lastComputedAtMs ?? null;
  const warnings = snap?.warnings ?? [];

  return {
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    isRefreshing,
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
