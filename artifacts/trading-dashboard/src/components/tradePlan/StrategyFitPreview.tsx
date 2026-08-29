interface Plan {
  strategyId?: string | null;
  marketCondition?: string | null;
  confidenceLevel?: number | null;
}

export function StrategyFitPreview({ plan }: { plan: Plan }) {
  const conf = plan.confidenceLevel ?? null;
  const tier = conf == null ? "—" : conf >= 75 ? "Strong" : conf >= 60 ? "Acceptable" : "Low";
  const tierColor = conf == null ? "text-txt-secondary" : conf >= 75 ? "text-success" : conf >= 60 ? "text-warning" : "text-danger";
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="mb-3 text-sm font-semibold text-foreground">Strategy Fit</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-txt-secondary">Strategy</dt>
        <dd className="text-foreground">{plan.strategyId ?? "—"}</dd>
        <dt className="text-txt-secondary">Market condition</dt>
        <dd className="text-foreground">{plan.marketCondition ?? "—"}</dd>
        <dt className="text-txt-secondary">Confidence</dt>
        <dd className={tierColor}>{conf != null ? `${conf}% · ${tier}` : "—"}</dd>
      </dl>
    </div>
  );
}
