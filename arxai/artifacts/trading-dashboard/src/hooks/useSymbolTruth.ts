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
import type { ScannerTruth } from "@/lib/scannerTruth";

export interface UseSymbolTruthResult {
  /** Raw snapshot from the brain (null while loading / on error). */
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
   * frontend freshness authority (useScannerTruth) has RESOLVED and says the data
   * is not actionable (insufficient candles for the timeframe, stale, delayed,
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

const CAPPED_BEST_ACTION_TEXT =
  "Watch only — the live feed isn't confirmed for a live entry right now.";
const CAPPED_HEADLINE =
  "The live feed isn't confirmed for this market right now, so there's no directional read to show.";

export function useSymbolTruth(
  symbolDisplay: string,
  timeframe: string,
  opts?: { refetchInterval?: number; enabled?: boolean },
): UseSymbolTruthResult {
  const symbol = (symbolDisplay || "").toUpperCase();
  const canonicalTf = normalizeChartTimeframe(timeframe);
  const apiTf = toApiTimeframe(canonicalTf) as GetMeMarketTruthTf;

  const scanner = useScannerTruth(symbol, canonicalTf, {
    refetchInterval: opts?.refetchInterval,
  });

  const snapQ = useGetMeMarketTruth(
    symbol,
    { tf: apiTf },
    {
      query: {
        queryKey: getGetMeMarketTruthQueryKey(symbol, { tf: apiTf }),
        enabled: (opts?.enabled ?? true) && symbol.length > 0,
        refetchInterval: opts?.refetchInterval ?? 15_000,
        staleTime: 5_000,
      },
    },
  );

  const snapshot = snapQ.data ?? null;
  const scannerTruth = scanner.truth;

  const { verdict, actionCapped } = useMemo(() => {
    if (!snapshot) return { verdict: null as TruthVerdict | null, actionCapped: false };
    const sv = snapshot.verdict;
    // READABILITY CONTRACT (display-only chokepoint). The frontend freshness
    // authority applies STRICTER, per-timeframe minimum-candle + age budgets than
    // the server snapshot, so it can resolve a feed as not-actionable even when
    // the server composed a directional verdict. When it has RESOLVED and says the
    // data is not valid for a live read, NO directional bias/stage/evidence/best-
    // action may show: we neutralize the whole directional read to an honest
    // "feed not confirmed" state. One-way only (we never upgrade). This is
    // display-only and never grants, bypasses, or weakens any trade gate.
    const notActionable =
      scannerTruth != null && scannerTruth.actionable === false;
    if (!notActionable) return { verdict: sv, actionCapped: false };
    return {
      verdict: {
        ...sv,
        bias: "UNKNOWN" as const,
        stage: "UNKNOWN" as const,
        headline: CAPPED_HEADLINE,
        evidenceFor: [],
        evidenceAgainst: [],
        invalidation: null,
        bestAction: "WATCH_ONLY" as const,
        bestActionText: CAPPED_BEST_ACTION_TEXT,
      },
      actionCapped: true,
    };
  }, [snapshot, scannerTruth]);

  return {
    snapshot,
    scannerTruth,
    feedStatus: scanner.feedStatus,
    data: snapshot?.data ?? null,
    news: snapshot?.news ?? null,
    components: snapshot?.components ?? null,
    levels: snapshot?.levels ?? null,
    verdict,
    actionCapped,
    isLoading: scanner.isLoading || snapQ.isLoading,
    isError: scanner.isError || snapQ.isError,
    refetch: () => {
      scanner.refetch();
      void snapQ.refetch();
    },
  };
}
