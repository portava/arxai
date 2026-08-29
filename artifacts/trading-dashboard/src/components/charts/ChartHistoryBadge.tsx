import { Badge } from "@/components/ui/badge";
import { Loader2, History, CircleSlash } from "lucide-react";

// ChartHistoryBadge — honest deep-history indicator (Task #438).
//
// Shared by both charts (ARXNativeChart + the bespoke ScannerChartPanel) so the
// scroll-back depth story reads identically everywhere. It reports ONLY what the
// backend deep-history layer reported:
//   - loading: a back-page fetch is in flight
//   - provider ceiling: the provider cannot reach deeper (honest cap, verbatim
//     limitationReason) — NOT a fabricated/extrapolated history
//   - depth: how far back real cached/fetched bars actually reach (coverage vs
//     the per-timeframe target)
//
// It NEVER implies live: a back-page is historical by definition. This component
// is purely informational and gates nothing.

export interface ChartHistoryBadgeProps {
  /** A back-page fetch is currently in flight. */
  loading: boolean;
  /** Older bars may still exist behind the current view. */
  hasMore: boolean;
  /** A real provider depth ceiling was reached (honest cap, not truncation). */
  providerCapped: boolean;
  /** Verbatim reason deeper history is unavailable (shown when capped). */
  limitationReason: string | null;
  /** Deepest real coverage observed so far, in days (null if unknown). */
  coverageDays: number | null;
  /** Per-timeframe deep-history target in days (reporting only). */
  depthTargetDays: number;
  /** True once at least one back-page has been requested for this series. */
  loadedAny: boolean;
  className?: string;
}

function formatDepth(days: number): string {
  if (days >= 365) {
    const years = days / 365;
    return `${years >= 2 ? Math.round(years) : years.toFixed(1)}y`;
  }
  if (days >= 1) return `${Math.round(days)}d`;
  return "<1d";
}

export function ChartHistoryBadge({
  loading,
  hasMore,
  providerCapped,
  limitationReason,
  coverageDays,
  depthTargetDays,
  loadedAny,
  className,
}: ChartHistoryBadgeProps) {
  if (loading) {
    return (
      <Badge
        variant="outline"
        className={`flex items-center gap-1 border-ruby/25 bg-ruby/10 text-[10px] text-ruby ${className ?? ""}`}
        data-testid="chart-history-loading"
      >
        <Loader2 className="h-3 w-3 animate-spin" /> Loading history…
      </Badge>
    );
  }

  // Provider ceiling — show the honest reason. This takes precedence over the
  // neutral depth chip so the user understands WHY they can't scroll further.
  if (providerCapped) {
    return (
      <Badge
        variant="outline"
        className={`flex items-center gap-1 border-warning/25 bg-warning/10 text-[10px] text-warning ${className ?? ""}`}
        data-testid="chart-history-capped"
        title={limitationReason ?? undefined}
      >
        <CircleSlash className="h-3 w-3" />
        <span className="max-w-[14rem] truncate">
          {limitationReason ?? "Provider history limit reached"}
        </span>
      </Badge>
    );
  }

  // Nothing scrolled back yet and no coverage known — render nothing.
  if (!loadedAny && coverageDays == null) return null;

  const depthLabel =
    coverageDays != null ? formatDepth(coverageDays) : null;

  return (
    <Badge
      variant="outline"
      className={`flex items-center gap-1 border-border bg-muted/40 text-[10px] text-txt-secondary ${className ?? ""}`}
      data-testid="chart-history-depth"
      title={
        depthTargetDays > 0
          ? `History loaded${depthLabel ? ` · ${depthLabel}` : ""} (target ${formatDepth(depthTargetDays)})`
          : "Historical bars loaded"
      }
    >
      <History className="h-3 w-3" />
      {depthLabel ? `${depthLabel} history` : "History loaded"}
      {hasMore ? " · scroll for more" : ""}
    </Badge>
  );
}

export default ChartHistoryBadge;
