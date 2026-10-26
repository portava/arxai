import { useEffect, useState } from "react";
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
export function useGetMeOpportunityMap() {
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
export const getGetMeOpportunityMapQueryKey = () => ["offline-scanner"];

export const getGetWatchlistsQueryKey = () => ["offline-watchlists"];
export function useGetWatchlists() { return { data: [
  { id: 1, name: "FX focus", items: [{ symbol: "EURUSD" }, { symbol: "GBPUSD" }, { symbol: "AUDUSD" }] },
  { id: 2, name: "Synthetic context", items: [{ symbol: "Volatility 75 Index" }] },
], isError: false }; }
