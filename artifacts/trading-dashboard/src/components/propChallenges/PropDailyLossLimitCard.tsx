export function PropDailyLossLimitCard({ worstPct, worstDate, limit }: { worstPct: number; worstDate: string | null; limit: number }) {
  const pct = Math.max(0, Math.min(1, worstPct / limit));
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-slate-100">Worst-day loss vs daily limit</h3>
        <span className="font-mono text-slate-300">{(worstPct*100).toFixed(2)}% / {(limit*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full transition-all ${pct >= 1 ? "bg-red-500" : pct >= 0.8 ? "bg-amber-500" : "bg-slate-500"}`} style={{ width: `${pct*100}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Worst day: {worstDate ?? "—"}</p>
    </div>
  );
}
