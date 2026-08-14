// useScannerTruth — the single consumed scanner-truth source (Task #391).
//
// Composes the ONE honest market query (GET /api/chart/candles, shared cache)
// with the user's account-mode permissions (useTradingMode) and resolves them
// through the pure resolveScannerTruth contract. Every scanner surface (header
// strip, chart panel, timing card, Ruby reads, overlays, trade buttons) should
// consume this rather than re-deriving freshness/permission logic on its own.

import { useQuery } from "@tanstack/react-query";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useAssistantName } from "@/lib/assistant-name";
import {
  chartCandlesQueryKey,
  fetchChartCandles,
  toApiTimeframe,
  type ChartCandlesResult,
} from "@/lib/chartCandlesQuery";
import {
  resolveScannerTruth,
  type ScannerTruth,
  type ScannerTruthMode,
} from "@/lib/scannerTruth";

export interface UseScannerTruthResult {
  truth: ScannerTruth | null;
  /**
   * The raw feed status from the SAME shared candles query the truth resolved
   * from. Exposed so presentational chips (e.g. FeedConfidenceBadge) can render
   * without an independent feed-status poll that could diverge from the truth.
   */
  feedStatus: ChartFeedStatus | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const DEFAULT_LIMIT = 200;
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function useScannerTruth(
  symbolDisplay: string,
  timeframe: string,
  opts?: { limit?: number; refetchInterval?: number },
): UseScannerTruthResult {
  const symbol = (symbolDisplay || "").toUpperCase();
  const apiTf = toApiTimeframe(timeframe);
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const candlesQ = useQuery<ChartCandlesResult>({
    queryKey: chartCandlesQueryKey(symbol, apiTf, limit),
    queryFn: () => fetchChartCandles(symbol, apiTf, limit),
    enabled: symbol.length > 0,
    refetchInterval: opts?.refetchInterval ?? 15_000,
    staleTime: 5_000,
  });

  // Header feed-ok snapshot — resolved INSIDE the one truth source so the header
  // strip, chart, read-gate and cards all share an identical header-ok cap. No
  // surface re-applies applyHeaderCap on its own afterwards (Task #391).
  const headerSnapQ = useQuery<{ ok?: boolean }>({
    queryKey: ["scanner-header-snapshot", symbol],
    queryFn: async () => {
      const r = await fetch(
        `${BASE}/api/market-scanner/selected-market?symbol=${encodeURIComponent(symbol)}`,
        { credentials: "include" },
      );
      return r.json() as Promise<{ ok?: boolean }>;
    },
    enabled: symbol.length > 0,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const headerOk: boolean | null = headerSnapQ.data?.ok ?? null;

  const mode = useTradingMode();
  const { name: assistantName } = useAssistantName();

  const candles = candlesQ.data?.candles ?? [];
  const feedStatus = candlesQ.data?.feedStatus ?? null;
  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const first = candles.length > 0 ? candles[0] : null;

  const env = mode.envelope;
  const truthMode: ScannerTruthMode = {
    isLoading: mode.isLoading,
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
        timeframe,
        feedStatus,
        candleCount: candles.length,
        requestedCount: limit,
        firstTime: first ? new Date(first.time).toISOString() : null,
        lastTime: last ? new Date(last.time).toISOString() : null,
        lastClose: last ? last.close : null,
        // No trusted independent real-time quote exists: the only quote endpoint
        // is the simulator (the very source that caused the divergence bug and is
        // forbidden here). Single-sourcing candles eliminates the quote↔candle
        // divergence class entirely, so the consistency dimension stays neutral
        // rather than cross-checking against fabricated data (Task #391).
        quote: null,
        headerOk,
        mode: truthMode,
      }, assistantName)
    : null;

  return {
    truth,
    feedStatus,
    isLoading: candlesQ.isLoading || mode.isLoading,
    isError: candlesQ.isError,
    refetch: () => void candlesQ.refetch(),
  };
}
