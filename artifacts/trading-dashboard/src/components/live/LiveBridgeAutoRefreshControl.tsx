// LiveBridgeAutoRefreshControl — compact auto-refresh control for live
// surfaces. Renders an On/Off toggle, a Refresh Now button, a "Checked Ns ago"
// recency label, and a bridge-state badge (live/delayed/stale/offline).
//
// Usage: drop inside any header/toolbar that has access to useLiveBridgeRefresh.
// Accepts the hook's return value as props so the parent controls the shared state.
//
// HONESTY RULES:
//   - The badge never shows "live" when bridgeState is stale/offline.
//   - The spinner is only shown while isRefreshing (actual in-flight reload).

import { useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BridgeState } from "@/hooks/useLiveBridgeRefresh";

function formatAgo(lastRefreshAt: number | null): string {
  if (lastRefreshAt == null) return "—";
  const ageMs = Date.now() - lastRefreshAt;
  if (ageMs < 2_000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return "over 1h ago";
}

const BRIDGE_STATE_STYLES: Record<BridgeState, { dot: string; label: string; text: string }> = {
  live:    { dot: "bg-success animate-pulse", label: "Live",    text: "text-success" },
  delayed: { dot: "bg-warning",                  label: "Delayed", text: "text-warning"   },
  stale:   { dot: "bg-warning",                 label: "Stale",   text: "text-warning"  },
  offline: { dot: "bg-danger",                    label: "Offline", text: "text-danger"     },
};

export interface LiveBridgeAutoRefreshControlProps {
  autoRefreshEnabled: boolean;
  toggleAutoRefresh: () => void;
  refreshNow: () => void;
  isRefreshing: boolean;
  lastRefreshAt: number | null;
  nextRefreshInMs: number | null;
  bridgeState: BridgeState;
  /** Render a compact (icon-only) variant for tight headers. Default false. */
  compact?: boolean;
  className?: string;
}

export function LiveBridgeAutoRefreshControl({
  autoRefreshEnabled,
  toggleAutoRefresh,
  refreshNow,
  isRefreshing,
  lastRefreshAt,
  bridgeState,
  compact = false,
  className,
}: LiveBridgeAutoRefreshControlProps) {
  const style = BRIDGE_STATE_STYLES[bridgeState];

  const handleRefresh = useCallback(() => {
    if (!isRefreshing) refreshNow();
  }, [isRefreshing, refreshNow]);

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        <span
          className={cn("inline-block h-2 w-2 rounded-full flex-shrink-0", style.dot)}
          title={style.label}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="Refresh bridge data"
          aria-label="Refresh bridge data"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border/40 bg-muted/30 px-3 py-1.5 text-xs",
        className,
      )}
    >
      {/* Bridge state badge */}
      <div className="flex items-center gap-1.5">
        <span className={cn("inline-block h-2 w-2 rounded-full flex-shrink-0", style.dot)} />
        <span className={cn("font-medium", style.text)}>{style.label}</span>
      </div>

      {/* Last checked label */}
      <span className="text-muted-foreground hidden sm:inline">
        Checked {formatAgo(lastRefreshAt)}
      </span>

      {/* Refresh Now */}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 py-0 text-xs text-muted-foreground hover:text-foreground"
        onClick={handleRefresh}
        disabled={isRefreshing}
      >
        <RefreshCw className={cn("h-3 w-3", isRefreshing && "animate-spin")} />
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </Button>

      {/* Auto-refresh toggle */}
      <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground select-none">
        <Switch
          checked={autoRefreshEnabled}
          onCheckedChange={toggleAutoRefresh}
          className="h-4 w-7"
          aria-label="Auto-refresh"
        />
        <span className="hidden md:inline">Auto</span>
      </label>
    </div>
  );
}
