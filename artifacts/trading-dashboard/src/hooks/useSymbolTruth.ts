// useSymbolTruth — the ONE per-symbol Truth Snapshot consumer (Task #512).
//
// "One Truth, One Brain": every scanner / chart / Ruby surface on the same page
// must render the SAME freshness, news state, price, and component/composed
// verdicts. This hook wraps the backend brain (GET /api/me/market/truth/:symbol,
// which COMPOSES the existing resolvers server-side) and the already-single-
// sourced useScannerTruth (Task #391, the freshness/price/permission authority
// driven by the SAME /api/chart/candles the chart bars render from).
//
// Division of authority (deliberate — see the Task #512 architect review):
//  - Freshness + displayed price + permissions stay with useScannerTruth, so the
//    freshness badge never splits from the bars it describes.
//  - News, the four component verdicts (scanner/flame/timing/scalp), and the
//    composed verdict (bias/stage/evidence/best action/levels) come from the
//    snapshot — these are the truths that previously DIVERGED across surfaces.
//
// ONE-WAY CONSERVATIVE CAP: the snapshot can never make a surface look MORE live
// or MORE actionable than the frontend freshness authority. When
// useScannerTruth resolves the data as not actionable (insufficient candles,
// stale, historical-only, delayed, or blocked), an actionable BUY/SELL best
// action is downgraded to a non-actionable watch. We never upgrade in the other
// direction. This preserves the #391 freshness contract while unifying verdicts.

import { useMemo } from "react";
import {
  useGetMeMarketTruth,
  getGetMeMarketTruthQueryKey,
  type MarketTruthResponse,
  type TruthVerdict,
  type TruthNews,
  type TruthComponents,
  type TruthLevels,
  type TruthData,
  type GetMeMarketTruthTf,
  type ChartFeedStatus,
} from "@workspace/api-client-react";
import {
  normalizeChartTimeframe,
  toApiTimeframe,
} from "@/lib/chartCandlesQuery";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEvidenceDeadline } from "@/hooks/useEvidenceDeadline";
import { resolveSymbolTruthEvidence, SYMBOL_TRUTH_MAX_AGE_MS } from "@/lib/symbolTruthEvidence";
import type { ScannerTruth } from "@/lib/scannerTruth";

export interface UseSymbolTruthResult {
  /** Snapshot after the evidence cap (null while loading / on error / expired). */
  snapshot: MarketTruthResponse | null;
  /** The freshness/price/permission authority (shared #391 source). */
  scannerTruth: ScannerTruth | null;
  /** Shared feed status from the SAME candles query the chart renders. */
  feedStatus: ChartFeedStatus | null;

  /** Snapshot sub-objects, surfaced for convenience (null while loading). */
  data: TruthData | null;
  news: TruthNews | null;
  components: TruthComponents | null;
  levels: TruthLevels | null;
  /**
   * Composed verdict with the one-way conservative cap already applied. When the
   * frontend freshness authority (useScannerTruth) has not confirmed the data
   * is actionable (insufficient candles for the timeframe, stale, delayed,
   * historical-only, or blocked), this is a READABILITY-CONTRACT chokepoint: the
   * directional read is neutralized — bias/stage → UNKNOWN, evidence cleared,
   * invalidation dropped, headline replaced with an honest "feed not confirmed"
   * line, and bestAction downgraded to a non-actionable watch. We never upgrade
   * in the other direction. Display-only — this never grants or blocks a trade.
   */
  verdict: TruthVerdict | null;
  /** True when the cap neutralized the directional read / best action. */
  actionCapped: boolean;

  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useSymbolTruth(
  symbolDisplay: string,
  timeframe: string,
  opts?: { refetchInterval?: number; enabled?: boolean },
): UseSymbolTruthResult {
  const symbol = (symbolDisplay || "").trim().toUpperCase();
  const canonicalTf = normalizeChartTimeframe(timeframe);
  const apiTf = toApiTimeframe(canonicalTf) as GetMeMarketTruthTf;
  const { user } = useCurrentUser();
  const enabled = (opts?.enabled ?? true) && symbol.length > 0 && user != null;

  const scanner = useScannerTruth(symbol, canonicalTf, {
    refetchInterval: opts?.refetchInterval,
  });

  const snapQ = useGetMeMarketTruth(
    symbol,
    { tf: apiTf },
    {
      query: {
        queryKey: [...getGetMeMarketTruthQueryKey(symbol, { tf: apiTf }), { userId: user?.id ?? null }],
        enabled,
        refetchInterval: opts?.refetchInterval ?? 15_000,
        staleTime: 5_000,
      },
    },
  );

  const rawSnapshot = enabled ? snapQ.data ?? null : null;
  const scannerTruth = scanner.truth;
  const generatedAt = rawSnapshot?.generatedAt ? Date.parse(rawSnapshot.generatedAt) : NaN;
  const nowMs = useEvidenceDeadline(Number.isFinite(generatedAt) ? generatedAt + SYMBOL_TRUTH_MAX_AGE_MS + 1 : null);
  const { snapshot, actionCapped } = useMemo(() => resolveSymbolTruthEvidence({
    snapshot: rawSnapshot, symbol, apiTimeframe: apiTf, scannerTruth,
    scannerLastCandleAt: scanner.feedStatus?.lastCandleTime ?? null,
    scannerError: scanner.isError, snapshotError: snapQ.isError, nowMs,
  }), [rawSnapshot, symbol, apiTf, scannerTruth, scanner.feedStatus, scanner.isError, snapQ.isError, nowMs]);

  return {
    snapshot,
    scannerTruth,
    feedStatus: scanner.feedStatus,
    data: snapshot?.data ?? null,
    news: snapshot?.news ?? null,
    components: snapshot?.components ?? null,
    levels: snapshot?.levels ?? null,
    verdict: snapshot?.verdict ?? null,
    actionCapped,
    isLoading: scanner.isLoading || snapQ.isLoading,
    isError: scanner.isError || snapQ.isError,
    refetch: () => {
      scanner.refetch();
      void snapQ.refetch();
    },
  };
}
