import { safeDate } from "@/lib/safeFormat";

interface Plan {
  strategyId?: string | null;
  marketCondition?: string | null;
  confidenceLevel?: number | null;
  symbol?: string | null;
}

/** What validate reported about Chart Truth for the plan's symbol. */
export interface PlanChartCheck {
  status: "PASSED" | "LIMITED" | "NOT_CHECKED" | null;
  chartTruthScore: number | null;
  chartQualityNote: string | null;
  /** Confidence capped at the Chart Truth score (validate, LIMITED only). */
  effectiveConfidenceLevel: number | null;
  checkedAtIso: string;
}

function tierOf(conf: number): { tier: string; color: string } {
  if (conf >= 75) return { tier: "Strong", color: "text-green-400" };
  if (conf >= 60) return { tier: "Acceptable", color: "text-amber-400" };
  return { tier: "Low", color: "text-red-400" };
}

// confidenceLevel is the trader's own estimate, entered on the plan. When the
// last validate found the chart basis limited, the usable confidence is the
// server's cap (min of the estimate and the Chart Truth score); the tier is
// taken from that, never from the uncapped estimate.
export function StrategyFitPreview({ plan, chartCheck }: { plan: Plan; chartCheck?: PlanChartCheck | null }) {
  const conf = plan.confidenceLevel ?? null;
  const capped =
    chartCheck?.status === "LIMITED" && chartCheck.effectiveConfidenceLevel != null && conf != null
      ? Math.min(conf, chartCheck.effectiveConfidenceLevel)
      : null;
  const shown = capped ?? conf;
  const t = shown == null ? null : tierOf(shown);
  const at = chartCheck ? ` at validation (${safeDate(chartCheck.checkedAtIso)})` : "";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-3 text-sm font-semibold text-slate-100">Strategy Fit</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-400">Strategy</dt>
        <dd className="text-slate-100">{plan.strategyId ?? "—"}</dd>
        <dt className="text-slate-400">Market condition</dt>
        <dd className="text-slate-100">{plan.marketCondition ?? "—"}</dd>
        <dt className="text-slate-400">Your confidence</dt>
        <dd className={t?.color ?? "text-slate-400"}>
          {conf == null ? "—" : capped != null ? `${conf}% entered · usable ${capped}% · ${t!.tier}` : `${conf}% · ${t!.tier}`}
        </dd>
      </dl>
      {chartCheck?.status === "LIMITED" && chartCheck.chartQualityNote && (
        <p className="mt-2 text-xs text-amber-400">
          {chartCheck.chartQualityNote}
          {chartCheck.chartTruthScore != null && ` Chart Truth score ${Math.round(chartCheck.chartTruthScore)}${at}.`}
        </p>
      )}
      {chartCheck?.status === "PASSED" && (
        <p className="mt-2 text-xs text-slate-400">
          Chart Truth passed{chartCheck.chartTruthScore != null ? ` (score ${Math.round(chartCheck.chartTruthScore)})` : ""}{at}.
        </p>
      )}
      {chartCheck && (chartCheck.status === "NOT_CHECKED" || chartCheck.status == null) && (
        <p className="mt-2 text-xs text-amber-400">
          Chart Truth was not checked{at}: there was no recent chart read{plan.symbol ? ` for ${plan.symbol}` : ""}. The confidence above is your own estimate only.
        </p>
      )}
      {!chartCheck && (
        <p className="mt-2 text-xs text-slate-500">Your own estimate. Validate the plan to compare it with Chart Truth.</p>
      )}
    </div>
  );
}
