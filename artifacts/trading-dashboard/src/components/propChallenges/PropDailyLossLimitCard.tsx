export function PropDailyLossLimitCard({ worstPct, worstDate, limit }: { worstPct: number; worstDate: string | null; limit: number }) {
  const pct = Math.max(0, Math.min(1, worstPct / limit));
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-foreground">Worst-day loss vs daily limit</h3>
        <span className="font-mono text-txt-secondary">{(worstPct*100).toFixed(2)}% / {(limit*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full transition-all ${pct >= 1 ? "bg-danger" : pct >= 0.8 ? "bg-warning" : "bg-muted"}`} style={{ width: `${pct*100}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-txt-secondary">Worst day: {worstDate ?? "—"}</p>
    </div>
  );
}
