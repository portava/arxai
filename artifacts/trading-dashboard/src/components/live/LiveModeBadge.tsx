import { Lock, Zap, Shield, FlaskConical, ShieldOff, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useTradingMode } from "@/hooks/useTradingMode";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

// T003 — global account-mode badge in the AppLayout strip.
//
// Previously this component said "Simulator" for any user who was not
// currently armed for live, even if they had explicitly picked PAPER
// or DEMO. That contradicted the SafetyHeader badge whenever a user
// was actually in DEMO or PAPER mode.
//
// It now consumes the unified `useTradingMode()` envelope so it
// agrees with SafetyHeader and every page badge. This compact chip is
// the single global live/demo/blocked indicator (T025 removed the
// full-width TradingModeBanner billboard and SafetyHeader's mode pill).
// The kill-switch indicator still reads /api/me/live/arming directly
// because that flag is a hard runtime safety signal that should never
// depend on the resolver's availability.

type ArmingResp = { arming: null | { killSwitchEngaged: boolean } };

export function LiveModeBadge({ compact = false }: { compact?: boolean }) {
  const mode = useTradingMode();
  const { data: armingData } = useQuery<ArmingResp>({
    queryKey: ["live", "arming", "kill-switch-only"],
    queryFn: () => fetch(`${BASE}/api/me/live/arming`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const killed = !!armingData?.arming?.killSwitchEngaged;

  // Kill-switch takes precedence over everything.
  if (killed) {
    return (
      <a
        href={`${BASE}/live-trading`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide border",
          "bg-rose-500/15 border-rose-500/40 text-rose-300 hover:bg-rose-500/25 transition-colors",
        )}
        data-testid="live-mode-badge"
        title="Live trading kill switch is engaged"
      >
        <Shield className="h-3 w-3" /> KILL SWITCH
      </a>
    );
  }

  if (mode.isLoading || !mode.envelope) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium tracking-wide border bg-slate-500/10 border-slate-500/30 text-slate-400"
        data-testid="live-mode-badge"
      >
        <Lock className="h-3 w-3" /> …
      </span>
    );
  }

  // Live-armed but something is blocking dispatch (operator yanked
  // tradingMode, master switch off, allocation pending, etc.) — surface
  // amber so the user notices it is NOT actually live right now.
  if (mode.isLiveArmed && mode.cleanBlockedReason) {
    return (
      <a
        href={`${BASE}/live-trading`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-bold tracking-wide border",
          "bg-amber-500/15 border-amber-500/50 text-amber-300 hover:bg-amber-500/25 transition-colors",
        )}
        data-testid="live-mode-badge"
        title={mode.cleanBlockedReason}
      >
        <AlertTriangle className="h-3 w-3" />
        {compact ? "Live" : "Live Armed — Blocked"}
      </a>
    );
  }

  if (mode.isLiveShared) {
    return (
      <a
        href={`${BASE}/live-shared`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-bold tracking-wide border",
          "bg-red-500/15 border-red-500/60 text-red-300 hover:bg-red-500/25 transition-colors",
        )}
        data-testid="live-mode-badge"
        title={mode.cleanUserMessage}
      >
        <Zap className="h-3 w-3" />
        {compact ? "LIVE" : "LIVE · Shared MT5"}
      </a>
    );
  }

  if (mode.isDemo) {
    return (
      <a
        href={`${BASE}/live-trading`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold tracking-wide border",
          "bg-blue-500/10 border-blue-500/30 text-blue-300 hover:bg-blue-500/15 transition-colors",
        )}
        data-testid="live-mode-badge"
        title={mode.cleanUserMessage}
      >
        <FlaskConical className="h-3 w-3" /> Demo
      </a>
    );
  }

  // Paper mode badge removed (Phase 3 — Paper Trading is no longer a user-facing mode).
  // Legacy `mode.isPaper` callers fall through to the neutral status pill below.

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold tracking-wide border bg-slate-500/10 border-slate-500/30 text-slate-300"
      data-testid="live-mode-badge"
      title={mode.cleanUserMessage}
    >
      <ShieldOff className="h-3 w-3" /> Trading Off
    </span>
  );
}
