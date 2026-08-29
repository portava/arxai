export function PropDrawdownMeter({ ddPct, limit }: { ddPct: number; limit: number }) {
  const pct = Math.max(0, Math.min(1, ddPct / limit));
  const tone = pct >= 1 ? "from-danger/15 to-danger" : pct >= 0.8 ? "from-warning to-warning" : "from-muted to-muted";
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-foreground">Total drawdown</h3>
        <span className="font-mono text-txt-secondary">{(ddPct*100).toFixed(2)}% / {(limit*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full bg-gradient-to-r ${tone} transition-all`} style={{ width: `${pct*100}%` }} />
      </div>
      {pct >= 0.8 && pct < 1 && <p className="mt-2 text-[11px] text-warning">Approaching drawdown limit.</p>}
      {pct >= 1 && <p className="mt-2 text-[11px] text-danger">Drawdown limit breached — challenge fails on next evaluation.</p>}
    </div>
  );
}
