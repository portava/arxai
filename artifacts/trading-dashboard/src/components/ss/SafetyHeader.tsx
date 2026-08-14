import { useEffect, useState } from "react";
import { Lock, FlaskConical, Activity, Target, Inbox, Eye } from "lucide-react";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { useAllUnlocks } from "@/hooks/useFeatureUnlock";
import { useTradingMode } from "@/hooks/useTradingMode";

type Defer = { deferred: boolean; systemState: string; bannerText: string; brokerProvider: string; bridgeConnected: boolean };

// Build TT — global SafetyHeader. Surfaces FULL TESTER ACCESS state, MT5
// deferred status, and the live-chart hint from the spec. Informational only;
// never controls trading. Live broker execution remains gated by
// placeLiveOrderGuarded() regardless of what this banner says.
//
// T003: reads the unified mode envelope via useTradingMode() so every page
// agrees with this badge. The previous direct /api/me/trading/mode read
// was ambiguous (DEMO and LIVE both lit "Live Execution Armed").
export function SafetyHeader() {
  const unlocks = useAllUnlocks();
  const mode = useTradingMode();
  const [defer, setDefer] = useState<Defer | null>(null);
  const [chartLive, setChartLive] = useState(false);
  const [chartSymbol] = useChartSymbol();
  const [intentCount, setIntentCount] = useState<number | null>(null);
  const [simRunning, setSimRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Only poll MT5 / intent / sim status once the user has unlocked the
    // relevant feature. Keeps fresh browser sessions from leaking the
    // operator's global tester / MT5 state into the safety header.
    if (unlocks.mt5) {
      void fetch("/api/system/mt5-deferred-status").then(r => r.ok ? r.json() : null).then((d) => { if (!cancelled && d) setDefer(d); }).catch(() => {});
    }
    const check = () => setChartLive(typeof window !== "undefined" && !!(window as any).TradingView);
    check();
    const t = window.setInterval(check, 4000);
    const refresh = () => {
      if (unlocks.simulator) {
        void fetch("/api/live-intent/queue", { headers: { "x-security-role": "ADMIN" } }).then(r => r.ok ? r.json() : null).then(d => { if (!cancelled && d?.counts) setIntentCount(d.counts.total ?? 0); }).catch(() => {});
        void fetch("/api/market/session-status").then(r => r.ok ? r.json() : null).then(d => { if (!cancelled && d) setSimRunning(!!d.running); }).catch(() => {});
      }
    };
    refresh();
    const t2 = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(t); window.clearInterval(t2); };
  }, [unlocks.mt5, unlocks.simulator]);

  const mt5Connected = !!defer?.bridgeConnected;
  const testerBanner = defer
    ? (mt5Connected
        ? "MT5 CONNECTED — Broker execution available only through the guarded order router."
        : "FULL TESTER ACCESS ACTIVE — MT5 NOT CONNECTED. Live workflows are open for testing, but real broker execution is unavailable until MT5 bridge is connected.")
    : "Education & demo testing only. No real orders are placed.";

  return (
    <div
      className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      role="region"
      aria-label="Trading safety status"
    >
      <div className="mx-auto max-w-[1600px] px-3 md:px-6 py-1.5 text-[11px] md:text-xs">
        {/* Mobile: horizontal scroll strip. Desktop: wraps freely.
            Backend execution permission is enforced server-side regardless
            of any label shown here. */}
        <div className="flex md:flex-wrap items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-slate-500/15 text-slate-600 border border-slate-500/30 px-2 py-0.5 font-mono" title="Selected chart symbol">
            <Target className="h-3 w-3" /> {chartSymbol}
          </span>
          {/* T025 — the live/demo/off mode pill was removed here to avoid a
              second live indicator. The single source of truth for account
              mode is now the compact LiveModeBadge chip in the header row. */}
          {mode.isAdminPreviewingUserMode && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 font-semibold" title="Previewing as user — admin diagnostics hidden">
              <Eye className="h-3 w-3" aria-hidden="true" /> Previewing as User
            </span>
          )}
          {unlocks.mt5 && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-blue-500/15 text-blue-600 border border-blue-500/30 px-2 py-0.5 font-semibold">
              <Lock className="h-3 w-3" aria-hidden="true" /> Tester Access
            </span>
          )}
          {unlocks.mt5 && defer?.deferred && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-600 border border-amber-500/30 px-2 py-0.5 font-semibold" title={defer.bannerText}>
              <FlaskConical className="h-3 w-3" aria-hidden="true" /> Simulator
            </span>
          )}
          {chartLive && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 px-2 py-0.5 font-semibold">
              <Activity className="h-3 w-3" aria-hidden="true" /> Live Chart
            </span>
          )}
          {/* Sim Engine is an internal simulated price engine — never a
              real trading path. It must never appear on a LIVE_SHARED
              account's surface; gated to non-live operator/sim sessions. */}
          {unlocks.simulator && simRunning && !mode.isLiveShared && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-purple-500/15 text-purple-600 border border-purple-500/30 px-2 py-0.5 font-semibold" title="Internal simulated price engine">
              <FlaskConical className="h-3 w-3" /> Sim Engine
            </span>
          )}
          {unlocks.simulator && intentCount !== null && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-cyan-500/15 text-cyan-600 border border-cyan-500/30 px-2 py-0.5 font-semibold" title="Live intents captured (no broker placement)">
              <Inbox className="h-3 w-3" /> {intentCount} {intentCount === 1 ? "Intent" : "Intents"}
            </span>
          )}
        </div>
        {unlocks.mt5 && (
          <div className="hidden md:block mt-1 text-muted-foreground truncate">{testerBanner}</div>
        )}
      </div>
    </div>
  );
}
