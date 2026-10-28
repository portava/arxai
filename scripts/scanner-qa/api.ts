import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SYMBOL_REGISTRY } from "../../artifacts/trading-dashboard/src/lib/symbolRegistry";
const speedMode = new URLSearchParams(location.search).has("performance");
export const speedStats = { started: 0, completed: 0, cancelled: 0, active: 0, peak: 0 };
(window as any).__scannerRequests = speedStats;
function speedFixture(params: any) {
  const base = fixture();
  const rows = SYMBOL_REGISTRY.filter((entry) => params.marketGroup === "all" || entry.marketType === params.marketGroup).map((entry, i) => ({
    ...base.map.rows[i % base.map.rows.length], symbol: entry.canonicalSymbol, displayName: entry.displayName,
    hasLiveData: true, category: "READY_NOW", edgeScore: 80 - i % 30,
  }));
  return { ...base, universe: params.marketGroup, universeCount: rows.length,
    map: { rows, categories: Object.fromEntries(keys.map(key => [key, rows.filter(row => row.category === key)])),
      best: { bestScalp: rows[0] ?? null, bestMomentum: null, bestRetest: null, bestReversal: null }, scannedCount: rows.length, liveCount: rows.length },
    bestVsSelected: { selectedSymbol: params.selectedSymbol ?? null, selectedEdge: null, hasCleanerAlternative: false, best: null, message: params.selectedSymbol ? `Comparison for ${params.selectedSymbol}` : null },
  };
}
function useSpeedMap(params: any, options: any) {
  return useQuery({ ...options?.query, queryKey: options?.query?.queryKey ?? getGetMeOpportunityMapQueryKey(params),
    queryFn: ({ signal }) => new Promise((resolve, reject) => {
      speedStats.started++; speedStats.active++; speedStats.peak = Math.max(speedStats.peak, speedStats.active);
      const delay = params.selectedSymbol ? 450 : 20;
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); speedStats.active--; speedStats.completed++; resolve(speedFixture(params)); }, delay);
      const abort = () => { clearTimeout(timer); speedStats.active--; speedStats.cancelled++; reject(new DOMException("Fixture cancelled", "AbortError")); };
      signal.addEventListener("abort", abort, { once: true });
    }), retry: false,
  });
}
const keys = ["READY_NOW", "FORMING_SOON", "WATCH_AFTER_NEWS", "TOO_LATE", "AVOID", "NO_CLEAN_SETUP"];
export function fixture() {
  const rows = ["EURUSD", "GBPUSD", "XAUUSD", "USDJPY", "BTCUSD", "V75"].map((symbol, i) => ({
    symbol, displayName: symbol, direction: i % 2 ? "SELL" : "BUY", recommendedAction: "BUY",
    setupType: "Trend continuation", edgeScore: 75 - i * 7, entryQuality: 65,
    executionQuality: 80, newsRisk: i === 2 ? "high" : "none", hasLiveData: i !== 5,
    isLate: i === 3, reason: "Offline fixture: no actual market assessment.",
    category: keys[i], kind: "MOMENTUM", bestAction: "Fixture", stageLabel: "Fixture",
  }));
  return {
    universe: "all", timeframe: "M5", generatedAt: new Date().toISOString(), universeCount: 6,
    map: { rows, categories: Object.fromEntries(keys.map((key) => [key, rows.filter((r) => r.category === key)])),
      best: { bestScalp: rows[0], bestMomentum: rows[0], bestRetest: null, bestReversal: null },
      scannedCount: rows.length, liveCount: 5 },
    bestVsSelected: { hasCleanerAlternative: false, best: null, message: null },
    skippedSymbols: [], dataNote: null,
  };
}
export function useGetMeOpportunityMap(params?: any, options?: any) {
  if (speedMode) return useSpeedMap(params, options);
  const [data, setData] = useState(fixture);
  const [isError, setError] = useState(false);
  useEffect(() => {
    const handler = (event: Event) => {
      const kind = (event as CustomEvent<string>).detail;
      setError(kind === "error");
      setData(kind === "expired" ? { ...fixture(), generatedAt: new Date(Date.now() - 31_000).toISOString() } : fixture());
    };
    window.addEventListener("scanner-fixture", handler);
    return () => window.removeEventListener("scanner-fixture", handler);
  }, []);
  return { data, isLoading: false, isFetching: false, isError, refetch: () => { setError(false); setData(fixture()); } };
}
export const getGetMeOpportunityMapQueryKey = (params?: any) => ["/api/me/opportunity-map", params];

export const getGetWatchlistsQueryKey = () => ["offline-watchlists"];
export function useGetWatchlists() { return { data: [
  { id: 1, name: "FX focus", items: [{ symbol: "EURUSD" }, { symbol: "GBPUSD" }, { symbol: "AUDUSD" }] },
  { id: 2, name: "Synthetic context", items: [{ symbol: "Volatility 75 Index" }] },
], isError: false }; }
