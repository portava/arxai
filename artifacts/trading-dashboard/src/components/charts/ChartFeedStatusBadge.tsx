import { Badge } from "@/components/ui/badge";
import type { ChartDisplayStatus } from "@/lib/chart-display-status";
import { formatTrailingGap } from "@/lib/feed-confidence";

// Honest feed-status badge — shared by every chart surface (Task #349).
//
// Copy is FIXED per resolved display state and never reuses feedStatus.message /
// .warning: a clean upstream response can phrase those as "Live feed active …
// (mt5_broker)", which would contradict a capped non-LIVE surface and leak an
// internal source token (Task #347). LIVE / UNAVAILABLE render nothing here —
// LIVE is conveyed by the surface's own live-price affordance, UNAVAILABLE by
// its empty state.
//
// Task #780 — when `trailingIntervals` is supplied (Scanner header chip), the
// chip appends an inline "· N missing" count so a degrading feed is diagnosable
// without opening the feed-details popover. It reuses the shared
// `formatTrailingGap` (the SAME ChartFeedStatus.trailingIntervals the popover
// reads): suppressed for a current feed (<=1), honest "· —" when explicitly
// unknown. Callers that omit the prop (e.g. the position mini-chart) keep the
// bare copy unchanged.
export function ChartFeedStatusBadge({
  status,
  hasCandles,
  testIdPrefix = "chart",
  trailingIntervals,
}: {
  status: ChartDisplayStatus;
  hasCandles: boolean;
  testIdPrefix?: string;
  trailingIntervals?: number | null;
}) {
  const gap = formatTrailingGap(trailingIntervals);
  const gapSuffix = gap ? ` · ${gap}` : "";

  if (status === "FALLBACK_COMPOSITE") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] border-warning/25 text-warning bg-warning/5"
        data-testid={`${testIdPrefix}-feed-delayed`}
      >
        Delayed market data{gapSuffix}
      </Badge>
    );
  }
  if (status === "STALE") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] border-warning/25 text-warning bg-warning/5"
        data-testid={`${testIdPrefix}-feed-stale`}
      >
        Stale · last-known{gapSuffix}
      </Badge>
    );
  }
  if (status === "ANALYSIS_ONLY" && hasCandles) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] border-border text-muted-foreground bg-muted/60"
        data-testid={`${testIdPrefix}-feed-analysis`}
      >
        Live feed unavailable · Analysis only{gapSuffix}
      </Badge>
    );
  }
  return null;
}
