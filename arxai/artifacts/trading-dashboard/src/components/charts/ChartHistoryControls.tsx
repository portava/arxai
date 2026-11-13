import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface ChartHistoryControlsProps {
  loadedCount: number;
  oldestTimeMs: number | null;
  clockLabel: string;
  archiveCount: number;
  archiveLabel: string;
  loading: boolean;
  hasMore: boolean;
  canLoad: boolean;
  onLoadOlder: () => void;
  onFitHistory: () => void;
}

export function formatLoadedHistoryTime(timeMs: number | null): string {
  if (timeMs == null || !Number.isFinite(timeMs)) return "not available";
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) return "not available";
  // Deliberately omit "Z": source-clock MT5 history may not have a verified UTC
  // mapping. The adjacent clock label says whether UTC is actually qualified.
  return date.toISOString().replace("T", " ").slice(0, 16);
}

export function ChartHistoryControls({
  loadedCount,
  oldestTimeMs,
  clockLabel,
  archiveCount,
  archiveLabel,
  loading,
  hasMore,
  canLoad,
  onLoadOlder,
  onFitHistory,
}: ChartHistoryControlsProps) {
  const oldest = formatLoadedHistoryTime(oldestTimeMs);
  const label = `${loadedCount} candles loaded; oldest ${oldest}; ${clockLabel}`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="chart-history-controls">
      <Badge
        variant="outline"
        className="max-w-full whitespace-normal text-[10px] leading-4 text-zinc-300"
        data-testid="chart-loaded-window"
        aria-label={label}
        title={label}
      >
        {loadedCount} loaded · oldest {oldest} · {clockLabel}
      </Badge>
      {archiveCount > 0 && (
        <Badge
          variant="outline"
          className="text-[10px] leading-4 text-amber-200"
          data-testid="chart-archive-display-only"
          title="Archived candles are shown separately. Their original account-era source identity is unverified; they are excluded from verified analysis."
        >
          {archiveLabel} · {archiveCount} · identity unverified · display only
        </Badge>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        disabled={!canLoad || !hasMore || loading}
        onClick={onLoadOlder}
        aria-label={loading ? "Loading older candles" : "Load older candles"}
        title="Load the next older page without changing the current chart view"
        data-testid="chart-load-older"
      >
        <History className="mr-1 h-3 w-3" />
        {loading ? "Loading…" : "Load older"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        disabled={!canLoad}
        onClick={onFitHistory}
        aria-label="Fit all loaded chart history"
        title="Fit the visible and archived bars currently loaded"
        data-testid="chart-fit-history"
      >
        Fit history
      </Button>
    </div>
  );
}
