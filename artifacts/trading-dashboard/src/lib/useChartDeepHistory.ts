// Shared deep-history accumulator (Task #438).
//
// Wraps GET /api/chart/history so BOTH charts (ARXNativeChart and the bespoke
// ScannerChartPanel) get identical scroll-left "load older bars" behaviour from
// one honest source. It accumulates OLDER candles in front of the newest window,
// pages with the `before` cursor, pins ONE coherent source for the series, and
// surfaces the backend's honest limits verbatim (a forward-only provider reports
// providerLimitReached + limitationReason; a back-page is historical_only).
//
// SAFETY: market-data / telemetry only. No execution, no 16-gate, no arx_live_*,
// no balances, no fills. Never fabricates a bar — older candles come solely from
// the backend deep-history layer; on a provider ceiling we stop and report.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChartHistory } from "@/lib/chartCandlesQuery";
import type { Candle } from "@/components/scanner/scannerCandleAdapter";

export interface ChartDeepHistoryState {
  /** Older candles accumulated in front of the newest window (epoch-ms, ascending). */
  olderCandles: Candle[];
  /** True while a back-page fetch is in flight. */
  loading: boolean;
  /** Older bars may still exist (cache or a deep-cursor provider). */
  hasMore: boolean;
  /** A real provider ceiling was hit (honest cap, not truncation). */
  providerCapped: boolean;
  /** Human-readable reason deeper history is unavailable (null otherwise). */
  limitationReason: string | null;
  /** Deepest coverage observed so far for this series, in days (null if unknown). */
  coverageDays: number | null;
  /** Per-timeframe deep-history target in days (reporting only). */
  depthTargetDays: number;
  /** True once at least one back-page has been requested for this series. */
  loadedAny: boolean;
  /**
   * Request the next older page, strictly older than `oldestLoadedIso` (the
   * oldest bar currently on screen). No-op while loading, when exhausted, or
   * when there is nothing on screen yet to page behind.
   */
  loadOlder: (oldestLoadedIso: string | null) => void;
  /** Clear accumulated history (e.g. on an explicit reset). */
  reset: () => void;
}

function dedupeAscending(older: Candle[], incoming: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of incoming) byTime.set(c.time, c);
  for (const c of older) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function useChartDeepHistory(
  symbol: string,
  apiTf: string,
  enabled = true,
): ChartDeepHistoryState {
  const [olderCandles, setOlderCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [providerCapped, setProviderCapped] = useState(false);
  const [limitationReason, setLimitationReason] = useState<string | null>(null);
  const [coverageDays, setCoverageDays] = useState<number | null>(null);
  const [depthTargetDays, setDepthTargetDays] = useState(0);
  const [loadedAny, setLoadedAny] = useState(false);

  // The source pinned by the first page keeps the whole series coherent.
  const sourceRef = useRef<string | null>(null);
  // The next back-cursor (nextBefore) returned by the last page.
  const cursorRef = useRef<string | null>(null);
  // Guards against overlapping fetches independent of the async state setter.
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    sourceRef.current = null;
    cursorRef.current = null;
    inFlightRef.current = false;
    setOlderCandles([]);
    setLoading(false);
    setHasMore(true);
    setProviderCapped(false);
    setLimitationReason(null);
    setCoverageDays(null);
    setDepthTargetDays(0);
    setLoadedAny(false);
  }, []);

  // Reset whenever the series identity changes so pages never cross symbols/tfs.
  useEffect(() => {
    reset();
  }, [symbol, apiTf, reset]);

  const loadOlder = useCallback(
    (oldestLoadedIso: string | null) => {
      if (!enabled || inFlightRef.current) return;
      if (!hasMore) return;
      const before = cursorRef.current ?? oldestLoadedIso;
      if (!before) return; // nothing on screen yet to page behind

      inFlightRef.current = true;
      setLoading(true);
      setLoadedAny(true);

      void (async () => {
        try {
          const page = await fetchChartHistory({
            symbol,
            apiTf,
            limit: 500,
            before,
            source: sourceRef.current,
          });
          if (page.source) sourceRef.current = page.source;
          cursorRef.current = page.nextBefore;
          if (page.candles.length > 0) {
            setOlderCandles((prev) => dedupeAscending(prev, page.candles));
          }
          setHasMore(page.hasMoreHistory && page.nextBefore != null);
          setProviderCapped(page.providerLimitReached);
          setLimitationReason(page.limitationReason ?? page.providerMessage);
          if (page.coverageDays != null) setCoverageDays(page.coverageDays);
          if (page.depthTargetDays > 0) setDepthTargetDays(page.depthTargetDays);
        } catch {
          // Network/parse failure: stop paging rather than silently retrying in a
          // loop. The chart keeps the bars it already has; nothing is fabricated.
          setHasMore(false);
        } finally {
          inFlightRef.current = false;
          setLoading(false);
        }
      })();
    },
    [enabled, hasMore, symbol, apiTf],
  );

  return {
    olderCandles,
    loading,
    hasMore,
    providerCapped,
    limitationReason,
    coverageDays,
    depthTargetDays,
    loadedAny,
    loadOlder,
    reset,
  };
}
