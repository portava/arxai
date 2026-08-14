interface Plan {
  strategyId?: string | null;
  marketCondition?: string | null;
  confidenceLevel?: number | null;
}

export function StrategyFitPreview({ plan }: { plan: Plan }) {
  const conf = plan.confidenceLevel ?? null;
  const tier = conf == null ? "—" : conf >= 75 ? "Strong" : conf >= 60 ? "Acceptable" : "Low";
  const tierColor = conf == null ? "text-slate-400" : conf >= 75 ? "text-green-400" : conf >= 60 ? "text-amber-400" : "text-red-400";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-3 text-sm font-semibold text-slate-100">Strategy Fit</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-400">Strategy</dt>
        <dd className="text-slate-100">{plan.strategyId ?? "—"}</dd>
        <dt className="text-slate-400">Market condition</dt>
        <dd className="text-slate-100">{plan.marketCondition ?? "—"}</dd>
        <dt className="text-slate-400">Confidence</dt>
        <dd className={tierColor}>{conf != null ? `${conf}% · ${tier}` : "—"}</dd>
      </dl>
    </div>
  );
}
