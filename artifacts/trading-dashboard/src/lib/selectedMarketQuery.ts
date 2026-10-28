import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { normalizeChartTimeframe, toApiTimeframe } from "@/lib/chartCandlesQuery";
import { resolveSymbol } from "@/lib/symbolRegistry";
import { bareSymbol } from "@/lib/use-chart-symbol";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type ImpactLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Bias = "BUY" | "SELL" | "NEUTRAL" | "WAIT";

interface SelectedMarketEvent {
  externalId: string;
  title: string;
  currency: string;
  impactLevel: ImpactLevel;
  eventTime: string;
  minutesUntil: number;
}

type DataState = "LIVE_CONFIRMED" | "SYNCING" | "STALE" | "UNAVAILABLE";

export interface SnapshotOk {
  ok: true;
  symbolRaw: string;
  symbol: string;
  timeframe: string;
  highlights: {
    bias: Bias;
    confidenceLabel: string;
    confidenceScore: number;
    volatilityLabel: string;
    trendState: string;
    // Levels are withheld (null) when the stale-level guard fires or the feed
    // has no confirmed candles — never rendered as numbers in those states.
    entryZone: { low: number; high: number } | null;
    suggestedStop: number | null;
    suggestedTakeProfit: number | null;
    riskRewardRatio: number;
    riskWarnings: string[];
  };
  explanation: {
    hedge: string;
    why: string;
    whyItMatters: string;
    risk: string;
    invalidation: string;
    cautions: string[];
    disclaimer: string;
  };
  upcomingEvents: SelectedMarketEvent[];
  newsRisk: { riskLevel: string; blockTrading: boolean; summary: string };
  // Additive truth fields (Task #518). dataAsOf = the DATA timestamp (newest
  // confirmed candle), distinct from generatedAt (analysis build time).
  dataSource?: string;
  dataSourceLabel?: string | null;
  dataState?: DataState;
  dataAsOf?: string | null;
  levelsWithheld?: boolean;
  levelsWithheldReason?: string | null;
  /** Why no directional read is shown (stale/syncing feed, too few bars); null when one is. */
  readWithheldReason?: string | null;
  generatedAt: string;
  cacheHit: boolean;
}

export interface SnapshotUnavailable {
  ok: false;
  symbol?: string;
  reason?: string;
  message: string;
}

export type Snapshot = SnapshotOk | SnapshotUnavailable;

/** Canonical cache identity never includes a previous user's analysis. */
export function selectedMarketIdentity(userId: number | null, symbol: string, timeframe: string) {
  const bare = bareSymbol(symbol).trim().toUpperCase();
  const canonical = resolveSymbol(bare)?.canonicalSymbol ?? bare;
  return { userId, symbol: canonical, timeframe: toApiTimeframe(normalizeChartTimeframe(timeframe)) };
}

type Identity = ReturnType<typeof selectedMarketIdentity>;
export function selectedMarketQueryKey(identity: Identity) {
  return ["scanner", "selected-market", identity.userId, identity.symbol, identity.timeframe] as const;
}

export async function fetchSelectedMarket(identity: Identity, signal: AbortSignal, refresh = false): Promise<Snapshot> {
  if (!identity.userId || !identity.symbol) throw new Error("Sign in and select a market.");
  const params = new URLSearchParams({ symbol: identity.symbol, timeframe: identity.timeframe });
  if (refresh) params.set("refresh", "1");
  const response = await fetch(`${BASE}/api/market-scanner/selected-market?${params}`, {
    credentials: "include", signal,
  });
  if (!response.ok) throw new Error(`Market analysis request failed (${response.status}).`);
  const value = await response.json() as Snapshot;
  if (!value || typeof value.ok !== "boolean") throw new Error("Market analysis response is incomplete.");
  if (value.ok && (value.symbol !== identity.symbol || value.timeframe !== identity.timeframe || !value.highlights || !value.explanation)) {
    throw new Error("Market analysis does not match the selected market and timeframe.");
  }
  return value;
}

export function selectedMarketQueryOptions(userId: number | null, symbol: string, timeframe: string) {
  const identity = selectedMarketIdentity(userId, symbol, timeframe);
  return queryOptions({
    queryKey: selectedMarketQueryKey(identity),
    queryFn: ({ signal }) => fetchSelectedMarket(identity, signal),
    enabled: Number.isSafeInteger(userId) && Number(userId) > 0 && identity.symbol.length > 0,
    // Preserve the header's existing freshness/poll budget; no longer-lived cache.
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// A user refresh supersedes an older ordinary read. Repeated refresh clicks or
// simultaneous observers join ONE forced read; fetchQuery publishes its exact
// response into the ordinary query once, with no follow-up network request.
const refreshes = new WeakMap<QueryClient, Map<string, Promise<Snapshot>>>();
export function refreshSelectedMarket(client: QueryClient, userId: number | null, symbol: string, timeframe: string): Promise<Snapshot> {
  const identity = selectedMarketIdentity(userId, symbol, timeframe);
  const options = selectedMarketQueryOptions(userId, symbol, timeframe);
  if (!options.enabled) return Promise.reject(new Error("Sign in and select a market."));
  let pending = refreshes.get(client);
  if (!pending) { pending = new Map(); refreshes.set(client, pending); }
  const key = JSON.stringify(options.queryKey);
  const existing = pending.get(key);
  if (existing) return existing;
  const originatingQuery = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
  const request = (async () => {
    await client.cancelQueries({ queryKey: options.queryKey, exact: true });
    if (!originatingQuery || client.getQueryCache().find({ queryKey: options.queryKey, exact: true }) !== originatingQuery
      || client.getQueryData<{ id: number }>(["me"])?.id !== userId) {
      throw new Error("Market selection session changed during refresh.");
    }
    return client.fetchQuery({
      ...options,
      staleTime: 0,
      queryFn: ({ signal }) => fetchSelectedMarket(identity, signal, true),
    });
  })();
  pending.set(key, request);
  const clean = () => { if (pending.get(key) === request) pending.delete(key); };
  void request.then(clean, clean);
  return request;
}
