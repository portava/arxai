// useScannerTruth — the single consumed scanner-truth source (Task #391).
//
// Composes the ONE honest market query (GET /api/chart/candles, shared cache)
// with the user's account-mode permissions (useTradingMode) and resolves them
// through the pure resolveScannerTruth contract. Every scanner surface (header
// strip, chart panel, timing card, Eleanor reads, overlays, trade buttons) should
// consume this rather than re-deriving freshness/permission logic on its own.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { resolveDisplayPricePrecision } from "@/lib/instrumentPriceFormat";
import { useSelectedMarketSnapshot } from "@/hooks/useSelectedMarketSnapshot";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useAssistantName } from "@/lib/assistant-name";
import { useEvidenceDeadline } from "@/hooks/useEvidenceDeadline";
import {
  chartCandlesQueryKey,
  fetchChartCandles,
  toApiTimeframe,
  normalizeChartTimeframe,
  type ChartCandlesResult,
} from "@/lib/chartCandlesQuery";
import {
  resolveScannerTruth,
  type ScannerHeaderCapReason,
  nextWeekendClosureBoundaryMs,
  type ScannerTruth,
  type ScannerTruthMode,
} from "@/lib/scannerTruth";
import { candleIntervalMs } from "@workspace/domain/market";
import { sharedChartResponse } from "@/lib/chart-engine/sharedChartResponse";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { selectSmartChartWindow } from "@/lib/chart-engine/smartChartAnalysis";
import { adaptChartCandles } from "@/components/scanner/scannerCandleAdapter";
import { chartUtcClockQualified } from "@/lib/chart-engine/chartClockEvidence";

export interface UseScannerTruthResult {
  truth: ScannerTruth | null;
  /**
   * The raw feed status from the SAME shared candles query the truth resolved
   * from. Exposed so presentational chips (e.g. FeedConfidenceBadge) can render
   * without an independent feed-status poll that could diverge from the truth.
   */
  feedStatus: ChartFeedStatus | null;
  /** Observed source identity from the same chart query, never reconstructed. */
  sourceIdentity: string | null;
  /**
   * Close time (ISO) of the newest CLOSED bar in the same shared candles — the
   * observation the server's truth snapshot reports as data.lastCandleAt. Not
   * feedStatus.lastCandleTime, which for a still-forming bar is its scheduled
   * future close. Null when the original identity, finality or closed window
   * cannot be confirmed.
   */
  lastClosedCandleAt: string | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const DEFAULT_LIMIT = 200;

function candleTimeIso(time: number | undefined): string | null {
  if (time == null) return null;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function useScannerTruth(
  symbolDisplay: string,
  timeframe: string,
  opts?: { limit?: number; refetchInterval?: number },
): UseScannerTruthResult {
  const symbol = (symbolDisplay || "").trim().toUpperCase();
  const chartTimeframe = normalizeChartTimeframe(timeframe);
  const apiTf = toApiTimeframe(chartTimeframe);
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const candlesQ = useQuery<ChartCandlesResult>({
    queryKey: chartCandlesQueryKey(symbol, apiTf, limit),
    queryFn: ({ signal }) => fetchChartCandles(symbol, apiTf, limit, signal),
    enabled: symbol.length > 0,
    refetchInterval: opts?.refetchInterval ?? 15_000,
    staleTime: 5_000,
  });

  // Header feed-ok snapshot — resolved INSIDE the one truth source so the header
  // strip, chart, read-gate and cards all share an identical header-ok cap. No
  // surface re-applies applyHeaderCap on its own afterwards (Task #391).
  const headerSnapQ = useSelectedMarketSnapshot(symbol, chartTimeframe);
  // Still loading / failed / ok:false all keep the live read withheld (false);
  // headerCapReason only makes the stated reason true for each case.
  const headerOk: boolean | null = headerSnapQ.isError ? false : headerSnapQ.data?.ok ?? false;
  const headerCapReason: ScannerHeaderCapReason | null = candlesQ.isError
    ? "candles_refresh_failed"
    : headerSnapQ.isError
      ? "analysis_request_failed"
      : headerSnapQ.data == null
        ? "analysis_pending"
        : headerSnapQ.data.ok === true
          ? null
          : "analysis_unavailable";

  const mode = useTradingMode();
  const { name: assistantName } = useAssistantName();

  const originalResponse = candlesQ.data?.originalResponse;
  const normalizedResponse = useMemo(
    () => sharedChartResponse(originalResponse, symbol, apiTf),
    [originalResponse, symbol, apiTf],
  );
  // The transport always supplies originalResponse. Match Smart Chart's
  // identity/shape check before allowing its lossy display adapter to support
  // any read. A legacy cached projection cannot prove the original evidence.
  const candles = useMemo(() => normalizedResponse
    ? adaptChartCandles(normalizedResponse.candles.map(c => ({ ...c }))) : [], [normalizedResponse]);
  const feedStatus = normalizedResponse?.feedStatus ?? null;
  // Bar times are UTC only with original-UTC clock evidence on every bar (the
  // chart axis rule); MT5 bars stay on the broker's trade-server clock.
  const barClockUtc = useMemo(
    () => chartUtcClockQualified(normalizedResponse?.candles ?? []),
    [normalizedResponse],
  );
  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const first = candles.length > 0 ? candles[0] : null;
  const lastTime = candleTimeIso(last?.time);
  // ONE display precision for the instrument, shared by every price surface.
  const serverPrecision = candlesQ.data?.pricePrecision ?? null;
  const pricePrecision = useMemo(
    () => resolveDisplayPricePrecision(serverPrecision, candles.flatMap((c) => [c.open, c.high, c.low, c.close])),
    [serverPrecision, candles],
  );
  // Use Smart Chart's actual capture/window validators: source identity,
  // OHLC, chronological uniqueness, finality, interval bounds and observation
  // cutoff are one contract. No independently mutable adapter metadata votes.
  const renderNowMs = Date.now();
  const captured = captureSmartChartBars(normalizedResponse, { symbol, timeframe: apiTf }, [], null, renderNowMs);
  const window = selectSmartChartWindow({ ...captured.context, bars: captured.bars, asOfMs: renderNowMs });
  const sourceEvidenceConfirmed = captured.status === "ready" && window.status === "ready";
  const observedClosedBars = sourceEvidenceConfirmed ? window.bars : [];
  const newestObservedClosed = observedClosedBars.at(-1);
  const lastClosedTime = newestObservedClosed ? candleTimeIso(newestObservedClosed.time * 1000) : null;
  const lastClosedCandleAt = newestObservedClosed ? candleTimeIso(newestObservedClosed.closeTime * 1000) : null;
  // Re-resolve at the earliest future evidence deadline: the next candle
  // interval boundary, or the start/end of a scheduled weekend closure.
  // The shared trailing-interval rule only changes class at an interval
  // boundary (the gap is measured from floor(now / interval)), so the next
  // boundary is the exact next evidence deadline.
  const candleIvMs = candleIntervalMs(chartTimeframe);
  const candleDeadline = lastTime != null && candleIvMs != null
    ? (Math.floor(renderNowMs / candleIvMs) + 1) * candleIvMs
    : null;
  const closureBoundary = nextWeekendClosureBoundaryMs(feedStatus?.assetClass ?? null, renderNowMs);
  const futureDeadlines = [candleDeadline, closureBoundary == null ? null : closureBoundary + 1]
    .filter((d): d is number => d != null && Number.isFinite(d) && d > renderNowMs);
  const nowMs = useEvidenceDeadline(futureDeadlines.length > 0 ? Math.min(...futureDeadlines) : null);

  const env = mode.envelope;
  const truthMode: ScannerTruthMode = {
    isLoading: mode.isLoading,
    // Only an error with NO envelope leaves the flags unmeasured; a failed
    // refetch keeps the last envelope, whose flags are still a real read.
    isError: mode.isError && env == null,
    isDemo: mode.isDemo,
    isLiveShared: mode.isLiveShared,
    isPaper: mode.isPaper,
    isLiveArmed: mode.isLiveArmed,
    isFrozen: mode.isFrozen,
    canManualTrade: mode.canManualTrade,
    canAutoTrade: mode.canAutoTrade,
    isSharedMasterAssigned: mode.isSharedMasterAssigned,
    ownBridgeConnected: env?.accountShellStatus.accountMode === "PERSONAL_MT5",
    approvalStatus: env?.userApprovalStatus ?? env?.accountShellStatus.approvalStatus ?? null,
    frozenReason: env?.userFrozenStatus.freezeMessage ?? null,
    cleanBlockedReason: mode.cleanBlockedReason,
  };

  const truth = candlesQ.data
    ? resolveScannerTruth({
        symbolDisplay: symbol,
        symbolInternal: symbol,
        timeframe: chartTimeframe,
        feedStatus,
        candleCount: candles.length,
        // The exact confirmed window used by Smart Chart, never legacy display bars.
        closedCandleCount: observedClosedBars.length,
        lastClosedTime,
        barClockUtc,
        requestedCount: limit,
        firstTime: candleTimeIso(first?.time),
        lastTime,
        lastClose: last ? last.close : null,
        pricePrecision,
        // No trusted independent real-time quote exists: the only quote endpoint
        // is the simulator (the very source that caused the divergence bug and is
        // forbidden here). Single-sourcing candles eliminates the quote↔candle
        // divergence class entirely, so the consistency dimension stays neutral
        // rather than cross-checking against fabricated data (Task #391).
        quote: null,
        // Keep cached bars as historical context after a failed refresh, but
        // withdraw live affordances for every direct truth consumer as well.
        headerOk: candlesQ.isError || !sourceEvidenceConfirmed ? false : headerOk,
        headerCapReason: headerCapReason ?? (!sourceEvidenceConfirmed ? "candle_evidence_unconfirmed" : null),
        mode: truthMode,
        nowMs,
      }, assistantName)
    : null;

  return {
    truth,
    feedStatus,
    sourceIdentity: sourceEvidenceConfirmed ? captured.context.sourceIdentity : null,
    lastClosedCandleAt,
    isLoading: candlesQ.isLoading || mode.isLoading,
    isError: candlesQ.isError,
    refetch: () => void candlesQ.refetch(),
  };
}
