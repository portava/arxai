// Single environment/status pill — the ONE status line under the header.
// Picks exactly one state (never conflicting LIVE + Demo + Paused at once),
// resolved from the unified trading-mode envelope. Read-only.

import { CheckCircle2, AlertTriangle, PlugZap, Pause } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { cn } from "@/lib/utils";

export function EnvironmentPill() {
  const mode = useTradingMode();

  if (mode.isLoading) {
    return <div className="h-7 w-40 animate-pulse rounded-full bg-secondary/40" />;
  }

  // Priority: blocked/disconnected → frozen/paused → live → demo → sim.
  const state = mode.cleanBlockedReason
    ? { label: "Bridge Disconnected", dot: "bg-danger", text: "text-danger", icon: PlugZap, sub: mode.cleanBlockedReason }
    : mode.isFrozen
      ? { label: "Trading Paused", dot: "bg-warning", text: "text-warning", icon: Pause, sub: mode.cleanUserMessage }
      : mode.isLiveShared
        ? { label: "LIVE · Shared MT5", dot: "bg-success", text: "text-success", icon: CheckCircle2, sub: "All systems operational" }
        : mode.isDemo
          ? { label: "Demo · Simulator", dot: "bg-primary", text: "text-primary", icon: CheckCircle2, sub: "Demo environment" }
          : { label: mode.cleanModeLabel || "Simulator", dot: "bg-muted", text: "text-txt-secondary", icon: AlertTriangle, sub: mode.cleanUserMessage };

  const Icon = state.icon;

  return (
    <div className="flex flex-wrap items-center gap-2.5" data-testid="cockpit-env-pill">
      <span className={cn("inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm font-semibold", state.text)}>
        <span className={cn("h-2 w-2 rounded-full", state.dot)} />
        {state.label}
      </span>
      {state.sub && (
        <span className="inline-flex items-center gap-1.5 text-xs text-txt-secondary">
          <Icon className="h-3.5 w-3.5" />
          <span className="truncate max-w-[200px] sm:max-w-none">{state.sub}</span>
        </span>
      )}
    </div>
  );
}
