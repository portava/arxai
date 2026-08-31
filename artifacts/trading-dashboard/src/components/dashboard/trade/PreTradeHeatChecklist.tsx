// Pre-Trade Heat Checklist — Phase 3 timing intelligence advisory widget.
// Displayed in the Trade Command Room before entering a position.
// Advisory only — never blocks manual trading; existing Risk Governor rules
// are unchanged. Shows a low-tradeability warning when applicable.
//
// Fetches timing brain for the current symbol via useGetTimingBrain.
// Honest empty when data is unavailable (no fabrication).

import { cn } from "@/lib/utils";
import {
  useGetTimingBrain,
  getGetTimingBrainQueryKey,
} from "@workspace/api-client-react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Flame,
  BarChart3,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
} from "lucide-react";

interface CheckRow {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone: "pass" | "caution" | "warn" | "neutral";
  detail?: string;
}

const PERMISSION_PASS: Record<string, boolean> = {
  GO: true, WAIT_FOR_ENTRY: false, WAIT_NEWS: false, NO_TRADE: false, STAND_DOWN: false,
};
const PERMISSION_LABELS: Record<string, string> = {
  GO: "Go", WAIT_FOR_ENTRY: "Wait for entry", WAIT_NEWS: "Wait — news", NO_TRADE: "No trade", STAND_DOWN: "Stand down",
};
const GRADE_PASS: Record<string, boolean> = {
  "A+": true, A: true, B: true, C: false, D: false, F: false,
};
const NEWS_PHASE_LABELS: Record<string, string> = {
  NONE: "Clear", PRE_EVENT: "Pre-event", AT_EVENT: "Live event", POST_EVENT: "Post-event", SETTLED: "Settling",
};

function toneClass(tone: CheckRow["tone"]) {
  return tone === "pass" ? "text-success"
    : tone === "caution" ? "text-warning"
    : tone === "warn" ? "text-danger"
    : "text-txt-secondary";
}
function toneIcon(tone: CheckRow["tone"]) {
  return tone === "pass" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
    : tone === "caution" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
    : tone === "warn" ? <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
    : <Info className="h-3.5 w-3.5 shrink-0 text-txt-muted" />;
}

export function PreTradeHeatChecklist({ symbol, className }: { symbol: string; className?: string }) {
  const q = useGetTimingBrain(symbol, {}, {
    query: {
      queryKey: getGetTimingBrainQueryKey(symbol),
      refetchInterval: 60_000,
      retry: false,
    },
  });

  const r = q.data;

  // Loading state
  if (q.isLoading) {
    return (
      <div className={cn("rounded-xl border border-border bg-card/60 p-4", className)}>
        <div className="flex items-center gap-2 mb-3">
          <Flame className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Timing Check</span>
        </div>
        <div className="space-y-1.5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-border/40" />
          ))}
        </div>
      </div>
    );
  }

  // Honest empty when unavailable
  if (!r) {
    return (
      <div className={cn("rounded-xl border border-border bg-card/60 p-4", className)}>
        <div className="flex items-center gap-2 mb-2">
          <Flame className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Timing Check</span>
        </div>
        <p className="text-xs text-txt-muted">Timing data unavailable for {symbol}.</p>
      </div>
    );
  }

  // Honest collapse: label "unavailable" means the candle/quote feed is fully
  // down and every grade/permission/score below would be a clock-derived
  // default — never render those as market facts on a pre-trade surface.
  if (r.dataQuality.label === "unavailable") {
    return (
      <div className={cn("rounded-xl border border-border bg-card/60 p-4", className)}>
        <div className="flex items-center gap-2 mb-2">
          <Flame className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Timing Check</span>
          <span className="text-xs text-txt-muted">{symbol}</span>
        </div>
        <p className="text-xs text-txt-muted" data-testid="timing-check-unavailable">
          {r.dataQuality.note || `Not enough live data to produce a timing read for ${symbol}.`}
        </p>
      </div>
    );
  }

  const isEstimate = r.dataQuality.label === "basic_timing_estimate";
  const lowTradeability = r.tradeabilityScore < 40;
  const newsRisk = r.newsOverlay.phase !== "NONE";
  const newsBlocksTrade = r.newsOverlay.blocksTrade;

  const checks: CheckRow[] = [
    {
      label: "Heat",
      value: `${r.heatScore} — ${r.heatState.replace(/_/g, " ").toLowerCase()}`,
      icon: <Flame className="h-3.5 w-3.5 shrink-0 text-warning" />,
      tone: r.heatScore >= 50 ? "pass" : r.heatScore >= 30 ? "caution" : "neutral",
      detail: `${r.heatSource.explanation}`,
    },
    {
      label: "Tradeability",
      value: `${r.tradeabilityScore} / ${r.edgeScore} edge`,
      icon: <BarChart3 className="h-3.5 w-3.5 shrink-0 text-primary" />,
      tone: r.tradeabilityScore >= 60 ? "pass" : r.tradeabilityScore >= 40 ? "caution" : "warn",
    },
    {
      label: "News risk",
      value: newsBlocksTrade ? "Blocked" : newsRisk ? NEWS_PHASE_LABELS[r.newsOverlay.phase] ?? r.newsOverlay.phase : "Clear",
      icon: <AlertTriangle className={cn("h-3.5 w-3.5 shrink-0", newsBlocksTrade ? "text-danger" : newsRisk ? "text-warning" : "text-success")} />,
      tone: newsBlocksTrade ? "warn" : newsRisk ? "caution" : "pass",
      detail: r.newsOverlay.eventName ? `${r.newsOverlay.eventName}${r.newsOverlay.minutesUntil != null ? ` in ${r.newsOverlay.minutesUntil}m` : ""}` : undefined,
    },
    {
      label: "Timing grade",
      value: r.timingGrade,
      icon: <Flame className="h-3.5 w-3.5 shrink-0 text-primary" />,
      tone: GRADE_PASS[r.timingGrade] ? "pass" : r.timingGrade === "C" ? "caution" : "warn",
    },
    {
      label: "Entry permission",
      value: PERMISSION_LABELS[r.entryPermission] ?? r.entryPermission,
      icon: PERMISSION_PASS[r.entryPermission]
        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        : <Clock className="h-3.5 w-3.5 shrink-0 text-warning" />,
      tone: PERMISSION_PASS[r.entryPermission] ? "pass"
        : r.entryPermission === "STAND_DOWN" ? "warn"
        : "caution",
    },
    {
      label: "Best action",
      value: r.bestAction.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
      icon: r.bestAction === "BUY" ? <TrendingUp className="h-3.5 w-3.5 shrink-0 text-success" />
        : r.bestAction === "SELL" ? <TrendingDown className="h-3.5 w-3.5 shrink-0 text-danger" />
        : <Minus className="h-3.5 w-3.5 shrink-0 text-txt-muted" />,
      tone: (r.bestAction === "BUY" || r.bestAction === "SELL") ? "pass"
        : r.bestAction === "STAND_DOWN" ? "warn"
        : "caution",
    },
    {
      label: "Risk mode",
      value: r.dangerScore >= 70 ? "High danger" : r.dangerScore >= 45 ? "Moderate risk" : "Normal",
      icon: <ShieldAlert className={cn("h-3.5 w-3.5 shrink-0", r.dangerScore >= 70 ? "text-danger" : r.dangerScore >= 45 ? "text-warning" : "text-success")} />,
      tone: r.dangerScore >= 70 ? "warn" : r.dangerScore >= 45 ? "caution" : "pass",
      // trapProbability is an additive rule-points heuristic (uncalibrated) —
      // render it as a score out of 100 like the other pills, never with a "%"
      // that would present it as a measured probability.
      detail: r.trapProbability > 50 ? `Trap score ${r.trapProbability}/100` : undefined,
    },
  ];

  return (
    <div className={cn("rounded-xl border border-border bg-card/60 p-4", className)}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Timing Check</span>
          <span className="text-xs text-txt-muted">{symbol}</span>
        </div>
        <span className="text-xs text-txt-muted font-mono">{r.timingGrade} grade</span>
      </div>

      {/* Low tradeability warning — display only, no blocking */}
      {lowTradeability && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/[0.08] px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning mt-0.5" />
          <p className="text-xs text-warning leading-snug">
            Low tradeability ({r.tradeabilityScore}) — conditions are not clean for an entry right now.
            This is advisory only; you can still place a trade manually.
          </p>
        </div>
      )}

      {/* News blocks warning — display only, no blocking */}
      {newsBlocksTrade && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger mt-0.5" />
          <p className="text-xs text-danger leading-snug">
            News event active
            {r.newsOverlay.eventName ? ` (${r.newsOverlay.eventName})` : ""}
            — timing suggests waiting for the market to settle.
            Advisory only; trade submission is unaffected.
          </p>
        </div>
      )}

      {/* Checklist */}
      <div className="space-y-1.5">
        {checks.map((c) => (
          <div key={c.label} className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              {toneIcon(c.tone)}
              <span className="text-xs text-txt-secondary shrink-0">{c.label}</span>
              {c.detail && (
                <span className="truncate text-[10px] text-txt-muted italic">{c.detail}</span>
              )}
            </div>
            <span className={cn("text-xs font-semibold whitespace-nowrap", toneClass(c.tone))}>
              {c.value}
            </span>
          </div>
        ))}
      </div>

      {/* Action reason */}
      <p className="mt-3 text-[11px] italic text-txt-muted leading-snug border-t border-border/60 pt-2">
        {r.actionReason}
      </p>

      {/* Session + data quality */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-txt-muted">
          {r.session.sessionName}
          {r.session.isKillZoneActive ? " · Kill zone" : ""}
        </span>
        {isEstimate && (
          <span className="text-[9px] text-txt-muted">timing estimate</span>
        )}
      </div>
    </div>
  );
}
