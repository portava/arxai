// ChartFeedConfidence — self-fetching FeedConfidenceBadge for trade-decision
// surfaces that don't already track the chart feed status (the Trade Command
// Room quick-trade panel, the live-chart "Trade from chart" card).
//
// It resolves the SAME shared scanner truth the Scanner uses (see RubyChartRead)
// from the ONE honest candles query (useScannerTruth → /api/chart/candles), so
// every surface names the real data source — MT5 broker bars vs a third-party /
// synthetic fallback — identically, AND caps the badge by that resolved verdict:
// it can never claim Clean/AI when the truth for this symbol/timeframe is
// downgraded or still unresolved. Purely informational: it never gates, places,
// or modifies anything.

import { bareSymbol } from "@/lib/use-chart-symbol";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { normalizeChartTimeframe } from "@/lib/chartCandlesQuery";
import { resolveFeedBadgeVerdict } from "@/lib/rubyReadPanelState";

export interface ChartFeedConfidenceProps {
  /** Raw chart-bus symbol (may carry an exchange prefix like "FX:EURUSD"). */
  symbol: string;
  /** Chart- or contract-style timeframe label. Defaults to M15. */
  timeframe?: string;
}

export function ChartFeedConfidence({
  symbol,
  timeframe = "M15",
}: ChartFeedConfidenceProps) {
  const bare = bareSymbol(symbol || "").toUpperCase();
  // Single-source the feed status AND the resolved verdict from the ONE shared
  // candles query (Task #391) so the displayed chip can never disagree with the
  // verdict capping it. Normalize the timeframe first — useScannerTruth feeds it
  // to toApiTimeframe, which only understands chart-style ids ("15m"); a raw
  // contract label ("M15") would silently resolve the wrong (M5) feed.
  const { truth, feedStatus, isLoading } = useScannerTruth(
    bare,
    normalizeChartTimeframe(timeframe),
  );

  // Never flash a misleading "No feed" chip before the first result resolves.
  if (!bare || (isLoading && !feedStatus)) return null;
  // Cap the badge by the resolved scanner-truth verdict (Task #521) — mirrors
  // RubyChartRead so Clean/AI is impossible on a downgraded/unresolved feed.
  return (
    <FeedConfidenceBadge
      feedStatus={feedStatus}
      aiUsableResolved={resolveFeedBadgeVerdict(truth?.analysis.level ?? null)}
    />
  );
}

export default ChartFeedConfidence;
