export function PropProfitTargetMeter({ totalPct, target }: { totalPct: number; target: number }) {
  const pct = Math.max(0, Math.min(1, totalPct / target));
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-foreground">Profit target</h3>
        <span className="font-mono text-txt-secondary">{(totalPct*100).toFixed(2)}% / {(target*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-gradient-to-r from-success to-success transition-all" style={{ width: `${pct*100}%` }} />
      </div>
      {totalPct >= target && (
        <p className="mt-2 text-[11px] text-success">Profit target reached — minimum trading days + consistency still required.</p>
      )}
    </div>
  );
}
