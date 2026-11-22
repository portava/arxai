type Price = number | null | undefined;

interface PlanPrices {
  entry: Price;
  stop: Price;
  target: Price;
  direction: string;
  zoneMidpoint?: boolean;
}

export function PlanPayoff({ entry, stop, target, direction, zoneMidpoint }: PlanPrices) {
  if (entry == null || stop == null || target == null ||
      ![entry, stop, target].every(p => Number.isFinite(p) && p > 0)) {
    return <span aria-label="Payoff unavailable">—</span>;
  }
  const sign = direction === "BUY" ? 1 : direction === "SELL" ? -1 : 0;
  const risk = sign * (entry - stop);
  const reward = sign * (target - entry);
  if (risk <= 0 || reward <= 0) return <span aria-label="Payoff unavailable">—</span>;
  const rewardToRisk = reward / risk;
  const breakEven = 100 * risk / (risk + reward);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-mono" aria-label={`Target pays ${rewardToRisk.toFixed(2)} times risk. Show break-even win rate`}>
        {rewardToRisk.toFixed(2)}R
      </summary>
      <p className="mt-1 max-w-56 text-muted-foreground">
        Break-even win rate from {zoneMidpoint ? "the middle of the entry zone" : "the planned entry"} is {breakEven.toFixed(1)}% before fees and slippage.
        This assumes each trade closes at its full target or stop.
      </p>
    </details>
  );
}
