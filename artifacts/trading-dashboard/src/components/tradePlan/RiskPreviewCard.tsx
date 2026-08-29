interface Plan {
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  lotSize?: number | null;
  riskAmount?: number | null;
  maxLossAllowed?: number | null;
  rewardToRiskTarget?: number | null;
}

function rr(entry?: number | null, sl?: number | null, tp?: number | null): number | null {
  if (entry == null || sl == null || tp == null) return null;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  return Math.abs(tp - entry) / risk;
}

export function RiskPreviewCard({ plan }: { plan: Plan }) {
  const computedRr = rr(plan.entryPrice, plan.stopLoss, plan.takeProfit);
  const target = plan.rewardToRiskTarget ?? 1.5;
  const overLimit = plan.riskAmount != null && plan.maxLossAllowed != null && plan.riskAmount > plan.maxLossAllowed;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="mb-3 text-sm font-semibold text-foreground">Risk Preview</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-txt-secondary">Entry</dt>
        <dd className="text-foreground">{plan.entryPrice ?? "—"}</dd>
        <dt className="text-txt-secondary">Stop loss</dt>
        <dd className="text-foreground">{plan.stopLoss ?? "—"}</dd>
        <dt className="text-txt-secondary">Take profit</dt>
        <dd className="text-foreground">{plan.takeProfit ?? "—"}</dd>
        <dt className="text-txt-secondary">Lot size</dt>
        <dd className="text-foreground">{plan.lotSize ?? "—"}</dd>
        <dt className="text-txt-secondary">Risk amount</dt>
        <dd className={overLimit ? "text-danger" : "text-foreground"}>
          {plan.riskAmount ?? "—"} {plan.maxLossAllowed != null && <span className="text-txt-muted">/ max {plan.maxLossAllowed}</span>}
        </dd>
        <dt className="text-txt-secondary">Reward-to-risk</dt>
        <dd className={computedRr != null && computedRr < target ? "text-warning" : "text-foreground"}>
          {computedRr != null ? computedRr.toFixed(2) : "—"} <span className="text-txt-muted">/ target {target.toFixed(2)}</span>
        </dd>
      </dl>
    </div>
  );
}
