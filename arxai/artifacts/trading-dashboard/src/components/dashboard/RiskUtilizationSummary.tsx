import { AlertTriangle, Shield } from "lucide-react";
import { riskUtilizationPercent } from "@/lib/risk-budget";
import { useRiskBudgetSnapshot } from "@/hooks/useRiskBudgetSnapshot";

const cash = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—"
  : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function RiskUtilizationSummary() {
  const query = useRiskBudgetSnapshot();
  const budget = query.data;
  const utilization = budget ? riskUtilizationPercent(budget) : null;
  return <div className="arx-risk-usage" aria-label="Account risk utilization">
    <div className="flex items-center gap-2">
      <Shield size={14} className="text-cyan-300"/>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">Daily risk utilization</span>
      <span className="ml-auto text-[11px] font-mono font-semibold text-cyan-200">{query.isLoading ? "Loading…" : utilization == null ? "Unavailable" : `${utilization}%`}</span>
    </div>
    <div className="arx-risk-meter" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, Math.max(0, (utilization ?? 0) / 100))})` }}/></div>
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
      <span className="text-slate-400">Used <b className="ml-1 font-mono text-slate-200">{budget ? cash(budget.dailyRiskUsed) : "—"}</b></span>
      <span className="text-right text-slate-400">Remaining <b className="ml-1 font-mono text-slate-200">{budget ? cash(budget.dailyRiskRemaining) : "—"}</b></span>
      <span className="text-slate-400">Open risk <b className="ml-1 font-mono text-slate-200">{budget ? cash(budget.openRisk) : "—"}</b></span>
      <span className="text-right text-slate-400">Limit <b className="ml-1 font-mono text-slate-200">{budget ? cash(budget.dailyRiskLimit) : "—"}</b></span>
    </div>
    {query.isError && <p className="flex items-start gap-1.5 text-[10px] text-amber-300" role="status"><AlertTriangle size={12} className="mt-0.5 shrink-0"/>{budget ? "Risk budget refresh failed — values are last known." : "Risk utilization is unavailable; no value is inferred."}</p>}
    {budget && <p className="text-[9px] text-slate-500">Account-scoped budget · {budget.riskStatus}</p>}
  </div>;
}
