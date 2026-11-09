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

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { fetchChartHistory, type ChartHistoryPage } from "@/lib/chartCandlesQuery";
import type { Candle } from "@/components/scanner/scannerCandleAdapter";

export interface ChartDeepHistoryState {
  /** Older candles accumulated in front of the newest window (epoch-ms, ascending). */
  olderCandles: Candle[];
  /** Actual producer evidence retained for optional historical analysis. */
  analysisEvidence: ChartHistoryPage["historyEvidence"];
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
  /**
   * True once at least one back-page has actually delivered older bars for this
   * series. A requested, failed or empty page never sets it.
   */
  loadedAny: boolean;
  /**
   * Plain-English reason the last back-page request failed (network/parse),
   * after which paging stopped. Null when no request has failed.
   */
  loadError: string | null;
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
  source: string | null = null,
  evidenceIdentity: string | null = null,
  requireEvidence = false,
): ChartDeepHistoryState {
  const sourceIdentity = JSON.stringify([source, evidenceIdentity, requireEvidence]);
  const [olderCandles, setOlderCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [providerCapped, setProviderCapped] = useState(false);
  const [limitationReason, setLimitationReason] = useState<string | null>(null);
  const [coverageDays, setCoverageDays] = useState<number | null>(null);
  const [depthTargetDays, setDepthTargetDays] = useState(0);
  const [loadedAny, setLoadedAny] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analysisEvidence, setAnalysisEvidence] = useState<ChartHistoryPage["historyEvidence"]>(null);
  const analysisRefused = useRef(false);
  const analysisObservations = useRef(new Map<number,string>());
  const [stateIdentity, setStateIdentity] = useState({ symbol, apiTf, sourceIdentity });

  // The source pinned by the first page keeps the whole series coherent.
  const sourceRef = useRef<string | null>(null);
  // The next back-cursor (nextBefore) returned by the last page.
  const cursorRef = useRef<string | null>(null);
  // Guards against overlapping fetches independent of the async state setter.
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const identityRef = useRef({ symbol, apiTf, sourceIdentity, source });

  const reset = useCallback(() => {
    if (!mountedRef.current) return;
    // Invalidate before abort: even clients that finish after cancellation may
    // never change another series or clear a newer request's in-flight guard.
    generationRef.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    sourceRef.current = identityRef.current.source;
    cursorRef.current = null;
    inFlightRef.current = false;
    setStateIdentity(identityRef.current);
    setOlderCandles([]);
    setLoading(false);
    setHasMore(true);
    setProviderCapped(false);
    setLimitationReason(null);
    setCoverageDays(null);
    setDepthTargetDays(0);
    setLoadedAny(false);
    setLoadError(null);
    setAnalysisEvidence(null);
    analysisRefused.current = false;
    analysisObservations.current.clear();
  }, []);

  // Reset whenever the series identity changes so pages never cross symbols/tfs.
  useLayoutEffect(() => {
    mountedRef.current = true;
    identityRef.current = { symbol, apiTf, sourceIdentity, source };
    reset();
    return () => {
      mountedRef.current = false;
      generationRef.current++;
      requestRef.current?.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    };
  }, [symbol, apiTf, sourceIdentity, source, reset]);

  const loadOlder = useCallback(
    (oldestLoadedIso: string | null) => {
      if (!mountedRef.current || !enabled || inFlightRef.current) return;
      // A renderer may retain a prior series' reach-start callback briefly.
      if (identityRef.current.symbol !== symbol || identityRef.current.apiTf !== apiTf || identityRef.current.sourceIdentity !== sourceIdentity) return;
      if (!hasMore) return;
      const before = cursorRef.current ?? oldestLoadedIso;
      if (!before) return; // nothing on screen yet to page behind
      if (requireEvidence && (!source || !evidenceIdentity)) {
        setHasMore(false);
        setProviderCapped(true);
        setLimitationReason("Older history is unavailable until the chart's data-source identity can be verified.");
        return;
      }
      inFlightRef.current = true;
      const generation = generationRef.current;
      const controller = new AbortController();
      requestRef.current = controller;
      const isCurrent = () => mountedRef.current && generationRef.current === generation;
      setLoading(true);

      void (async () => {
        try {
          const page = await fetchChartHistory({
            symbol,
            apiTf,
            limit: 500,
            before,
            source: sourceRef.current,
            ...(evidenceIdentity ? { sourceIdentity: evidenceIdentity } : {}),
            signal: controller.signal,
          });
          if (!isCurrent()) return;
          if (source != null && page.source !== source) {
            setHasMore(false);
            setProviderCapped(true);
            setLimitationReason("Older history did not match the chart's data source.");
            return;
          }
          if ((requireEvidence || evidenceIdentity != null) && (!page.historyEvidence
            || page.historyEvidence.symbol !== symbol || page.historyEvidence.timeframe !== apiTf
            || page.historyEvidence.source !== source || page.historyEvidence.sourceIdentity !== evidenceIdentity)) {
            setHasMore(false);
            setProviderCapped(true);
            setLimitationReason(page.limitationReason ?? "Older history could not verify the chart's original data source.");
            return;
          }
          if (page.source) sourceRef.current = page.source;
          // Retain producer evidence, never stamp the newest feed's identity
          // onto an earlier page. Unattested pages remain display-only.
          if (page.candles.length > 0) {
            const observed = page.historyEvidence;
            const unit = apiTf.match(/^(M|H|D|W)(\d+)$/);
            const interval = apiTf === "MN1" ? 2592000 : unit ? Number(unit[2]) * ({M:60,H:3600,D:86400,W:604800}[unit[1] as "M"] ?? 0) : 0;
            const closedThrough = observed ? Date.parse(observed.lastClosedCandleAt) : NaN;
            let disagreement = false;
            for (let i=0;i<page.candles.length;i++) {
              const bar=page.candles[i]!, value=JSON.stringify([bar.open,bar.high,bar.low,bar.close]);
              const previous=analysisObservations.current.get(bar.time);
              if (!Number.isFinite(bar.time) || bar.time+interval*1000>closedThrough
                || (i>0 && bar.time<=page.candles[i-1]!.time) || (previous!=null && previous!==value)) disagreement=true;
              analysisObservations.current.set(bar.time,value);
            }
            if (!observed || observed.scope !== "public_provider" || !interval || !Number.isFinite(closedThrough)
              || closedThrough>Date.now() || disagreement) {
              analysisRefused.current = true;
              setAnalysisEvidence(null);
            } else if (!analysisRefused.current) {
              setAnalysisEvidence(previous => previous && Date.parse(previous.lastClosedCandleAt) > Date.parse(observed.lastClosedCandleAt) ? previous : observed);
            }
          }
          cursorRef.current = page.nextBefore;
          if (page.candles.length > 0) {
            setOlderCandles((prev) => isCurrent() ? dedupeAscending(prev, page.candles) : prev);
            setLoadedAny(true);
          }
          setHasMore(page.hasMoreHistory && page.nextBefore != null);
          setProviderCapped(page.providerLimitReached);
          setLimitationReason(page.limitationReason ?? page.providerMessage);
          if (page.coverageDays != null) setCoverageDays(page.coverageDays);
          if (page.depthTargetDays > 0) setDepthTargetDays(page.depthTargetDays);
        } catch {
          // Network/parse failure: stop paging rather than silently retrying in a
          // loop. The chart keeps the bars it already has; nothing is fabricated.
          if (isCurrent()) {
            setHasMore(false);
            setLoadError("Older history could not be loaded; scroll-back paging stopped.");
          }
        } finally {
          if (isCurrent()) {
            requestRef.current = null;
            inFlightRef.current = false;
            setLoading(false);
          }
        }
      })();
    },
    [enabled, hasMore, symbol, apiTf, sourceIdentity, source, evidenceIdentity, requireEvidence],
  );

  // Never expose the previous instrument's accumulated bars during the render
  // before its layout-effect reset. Both chart renderers share this contract.
  const currentState = stateIdentity.symbol === symbol && stateIdentity.apiTf === apiTf && stateIdentity.sourceIdentity === sourceIdentity;
  return {
    olderCandles: currentState ? olderCandles : [],
    analysisEvidence: currentState ? analysisEvidence : null,
    loading: currentState ? loading : false,
    hasMore: currentState ? hasMore : true,
    providerCapped: currentState ? providerCapped : false,
    limitationReason: currentState ? limitationReason : null,
    coverageDays: currentState ? coverageDays : null,
    depthTargetDays: currentState ? depthTargetDays : 0,
    loadedAny: currentState ? loadedAny : false,
    loadError: currentState ? loadError : null,
    loadOlder,
    reset,
  };
}
