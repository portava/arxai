// Scanner Timing Badges — Phase 3 advisory timing context display.
// Renders a compact row of heat/timing badges on scanner opportunity cards.
// Advisory only — never blocks or gates any trade action.
// Absent when timingContext is not present (honest empty).

import { cn } from "@/lib/utils";
import { Flame, Clock, AlertTriangle, TrendingUp, TrendingDown, Minus } from "lucide-react";

export interface ScannerTimingContext {
  heatScore: number;
  tradeabilityScore: number;
  edgeScore: number;
  dangerScore: number;
  timingGrade: string;
  entryPermission: string;
  heatState: string;
  bestAction: string;
  actionReason: string;
  pressureBias: "BUY" | "SELL" | "NEUTRAL";
  newsPhase: string;
  broadFlowVerdict: string;
  sessionName: string;
  isKillZoneActive: boolean;
  trapProbability: number;
  roomToMove: number;
  heatBoost: number;
  dataQualityLabel: string;
}

const PERMISSION_COLORS: Record<string, string> = {
  GO:              "bg-success/10 text-success border-success/25",
  WAIT_FOR_ENTRY:  "bg-warning/10 text-warning border-warning/25",
  WAIT_NEWS:       "bg-warning/10 text-warning border-warning/25",
  NO_TRADE:        "bg-muted/60 text-muted-foreground border-border",
  STAND_DOWN:      "bg-danger/10 text-danger border-danger/25",
};

const PERMISSION_LABELS: Record<string, string> = {
  GO:              "Go",
  WAIT_FOR_ENTRY:  "Wait entry",
  WAIT_NEWS:       "Wait news",
  NO_TRADE:        "No trade",
  STAND_DOWN:      "Stand down",
};

const GRADE_COLORS: Record<string, string> = {
  "A+": "bg-success/10 text-success border-success/25",
  A:    "bg-success/10 text-success border-success/25",
  B:    "bg-primary/10 text-primary border-primary/25",
  C:    "bg-warning/10 text-warning border-warning/25",
  D:    "bg-warning/10 text-warning border-warning/25",
  F:    "bg-danger/10 text-danger border-danger/25",
};

const NEWS_PHASE_LABELS: Record<string, string> = {
  PRE_EVENT:  "Pre-event",
  AT_EVENT:   "Live event",
  POST_EVENT: "Post-event",
  SETTLED:    "Settled",
  NONE:       "",
};

function ScorePill({ label, value, lo, hi, tone }: { label: string; value: number; lo: number; hi: number; tone?: "good" | "bad" }) {
  const pct = Math.round(((value - lo) / (hi - lo)) * 100);
  const color = tone === "good"
    ? value >= 65 ? "text-success" : value >= 45 ? "text-warning" : "text-muted-foreground"
    : tone === "bad"
      ? value >= 65 ? "text-danger" : value >= 45 ? "text-warning" : "text-muted-foreground"
      : "text-primary";
  void pct;
  return (
    <span className="flex flex-col items-center gap-0.5 rounded border border-border bg-background/30 px-1.5 py-0.5">
      <span className="text-[9px] uppercase tracking-wide text-txt-muted leading-none">{label}</span>
      <span className={cn("text-xs font-mono font-semibold leading-none", color)}>{value}</span>
    </span>
  );
}

export function ScannerTimingBadges({ ctx, className, isGold }: { ctx: ScannerTimingContext; className?: string; isGold?: boolean }) {
  if (!ctx) return null;

  // Honest collapse: with the candle/quote feed fully down the backend emits
  // dataQualityLabel="unavailable" — the grade/permission/score values in ctx
  // are clock-derived defaults, not market facts, so render a single honest
  // line instead of confident-looking badges.
  if (ctx.dataQualityLabel === "unavailable") {
    return (
      <div className={cn("border-t border-border/60 pt-2", className)} data-testid="scanner-timing-unavailable">
        <p className="text-[10px] text-txt-muted">
          Timing read unavailable — no live candle/quote data for this symbol.
        </p>
      </div>
    );
  }

  const isEstimate = ctx.dataQualityLabel === "basic_timing_estimate";
  const showNewsPhase = ctx.newsPhase !== "NONE" && !!NEWS_PHASE_LABELS[ctx.newsPhase];
  const heatBoostLabel = ctx.heatBoost > 0 ? `+${ctx.heatBoost}` : ctx.heatBoost < 0 ? `${ctx.heatBoost}` : null;

  return (
    <div className={cn("space-y-1.5 border-t border-border/60 pt-2", className)}>
      {/* Top row: grade + permission + news phase */}
      <div className="flex flex-wrap items-center gap-1">
        {/* Gold Strategy Mode marker (Task #657) — display-only; advisory, never gates. */}
        {isGold && (
          <span
            className="inline-flex items-center gap-1 rounded border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning leading-none"
            title="Gold Strategy Mode active — gold-specific macro/session/risk context (display-only)"
            data-testid="scanner-gold-badge"
          >
            <Flame className="h-2.5 w-2.5" />
            Gold mode
          </span>
        )}

        {/* Timing grade */}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold leading-none",
            GRADE_COLORS[ctx.timingGrade] ?? "bg-muted/60 text-muted-foreground border-border",
          )}
          title={`Timing grade: ${ctx.timingGrade}`}
        >
          <Flame className="h-2.5 w-2.5" />
          {ctx.timingGrade}
        </span>

        {/* Entry permission */}
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none",
            PERMISSION_COLORS[ctx.entryPermission] ?? "bg-muted/60 text-muted-foreground border-border",
          )}
          title={ctx.actionReason}
        >
          {PERMISSION_LABELS[ctx.entryPermission] ?? ctx.entryPermission}
        </span>

        {/* Kill zone */}
        {ctx.isKillZoneActive && (
          <span className="inline-flex items-center gap-1 rounded border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning leading-none">
            <Clock className="h-2.5 w-2.5" />
            Kill zone
          </span>
        )}

        {/* News phase */}
        {showNewsPhase && (
          <span className="inline-flex items-center gap-1 rounded border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning leading-none">
            <AlertTriangle className="h-2.5 w-2.5" />
            {NEWS_PHASE_LABELS[ctx.newsPhase]}
          </span>
        )}

        {/* Heat boost badge */}
        {heatBoostLabel && (
          <span
            className={cn(
              "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold leading-none",
              ctx.heatBoost > 0
                ? "border-success/25 bg-success/10 text-success"
                : "border-danger/25 bg-danger/10 text-danger",
            )}
            title="Heat-adjusted score boost"
          >
            {heatBoostLabel}
          </span>
        )}

        {/* Data quality marker */}
        {isEstimate && (
          <span className="ml-auto text-[9px] text-txt-muted">timing est.</span>
        )}
      </div>

      {/* Score pills row */}
      <div className="flex flex-wrap items-center gap-1">
        <ScorePill label="Heat" value={ctx.heatScore} lo={0} hi={100} tone="good" />
        <ScorePill label="Trade" value={ctx.tradeabilityScore} lo={0} hi={100} tone="good" />
        <ScorePill label="Danger" value={ctx.dangerScore} lo={0} hi={100} tone="bad" />

        {/* Pressure bias */}
        <span className={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none",
          ctx.pressureBias === "BUY"
            ? "border-success/40 bg-success/10 text-success"
            : ctx.pressureBias === "SELL"
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-border bg-background/30 text-txt-muted",
        )}>
          {ctx.pressureBias === "BUY" ? <TrendingUp className="h-2.5 w-2.5" />
            : ctx.pressureBias === "SELL" ? <TrendingDown className="h-2.5 w-2.5" />
            : <Minus className="h-2.5 w-2.5" />}
          {ctx.pressureBias}
        </span>

        {/* Broad flow */}
        {ctx.broadFlowVerdict !== "UNAVAILABLE" && ctx.broadFlowVerdict !== "NEUTRAL" && (
          <span className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none",
            ctx.broadFlowVerdict === "ALIGNED"
              ? "border-success/25 bg-success/10 text-success"
              : ctx.broadFlowVerdict === "OPPOSING"
                ? "border-danger/25 bg-danger/10 text-danger"
                : "border-warning/25 bg-warning/10 text-warning",
          )}>
            {ctx.broadFlowVerdict === "ALIGNED" ? "Aligned" : ctx.broadFlowVerdict === "OPPOSING" ? "Opposing" : "Conflicted"}
          </span>
        )}
      </div>

      {/* Action reason */}
      <p className="text-[10px] leading-snug text-txt-muted italic">{ctx.actionReason}</p>
    </div>
  );
}
