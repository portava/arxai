// Same thresholds as the evaluator (api-server routes/propChallenges.ts): a
// day breaches only when its loss is strictly ABOVE the limit, and warns only
// when strictly above 80% of it. Exactly at the limit is not a breach.
export function PropDailyLossLimitCard({ worstPct, worstDate, limit }: { worstPct: number; worstDate: string | null; limit: number }) {
  const pct = Math.max(0, Math.min(1, worstPct / limit));
  const breached = worstPct > limit;
  const warn = !breached && worstPct > limit * 0.8;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-slate-100">Worst-day loss vs daily limit</h3>
        <span className="font-mono text-slate-300">{(worstPct*100).toFixed(2)}% / {(limit*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div data-testid="bar-daily-loss" className={`h-full transition-all ${breached ? "bg-red-500" : warn ? "bg-amber-500" : "bg-slate-500"}`} style={{ width: `${pct*100}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Worst day: {worstDate ?? "—"}</p>
    </div>
  );
}
