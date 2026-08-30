// Single environment/status pill — the ONE status line under the header.
// Picks exactly one state (never conflicting LIVE + Demo + Paused at once),
// resolved from the unified trading-mode envelope. Read-only.

import { CheckCircle2, AlertTriangle, Ban, Pause } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { cn } from "@/lib/utils";

export function EnvironmentPill() {
  const mode = useTradingMode();

  if (mode.isLoading) {
    return <div className="h-7 w-40 animate-pulse rounded-full bg-secondary/40" />;
  }

  // A failed read is its own state — never fall through to a reassuring one.
  if (mode.isError || !mode.envelope) {
    return (
      <div className="flex flex-wrap items-center gap-2.5" data-testid="cockpit-env-pill">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm font-semibold text-txt-muted">
          <span className="h-2 w-2 rounded-full bg-muted" />
          Mode unknown
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-txt-secondary">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>Could not read your account mode.</span>
        </span>
      </div>
    );
  }

  // Priority: blocked → frozen/paused → live → demo → sim.
  //
  // `cleanBlockedReason` is NOT a bridge-connectivity signal. It is produced
  // for operator-set DISABLED, SIMULATED/DEMO mode, a non-ACTIVE trading
  // status, a pending shared-master assignment, the server master switch and
  // incomplete live confirmation (see computeAccountModePrecedence.ts). This
  // pill used to render it as a red "Bridge Disconnected" with a plug icon,
  // sending traders to debug MT5 connectivity that was never broken — and in
  // the other direction it asserted green "All systems operational" from the
  // mere ABSENCE of a block reason, reading no feed status, heartbeat,
  // kill-switch or health signal of any kind. Neither claim is made now.
  const state = mode.cleanBlockedReason
    ? { label: "Trading Blocked", dot: "bg-danger", text: "text-danger", icon: Ban, sub: mode.cleanBlockedReason }
    : mode.isFrozen
      ? { label: "Trading Paused", dot: "bg-warning", text: "text-warning", icon: Pause, sub: mode.cleanUserMessage }
      : mode.isLiveShared
        ? { label: "LIVE · Shared MT5", dot: "bg-success", text: "text-success", icon: CheckCircle2, sub: mode.cleanUserMessage || "No block on your account. Bridge health is not monitored here." }
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
