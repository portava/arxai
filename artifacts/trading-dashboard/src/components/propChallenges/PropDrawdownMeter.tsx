export function PropDrawdownMeter({ ddPct, limit }: { ddPct: number; limit: number }) {
  const pct = Math.max(0, Math.min(1, ddPct / limit));
  const tone = pct >= 1 ? "from-red-700 to-red-500" : pct >= 0.8 ? "from-amber-600 to-amber-400" : "from-slate-600 to-slate-400";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-slate-100">Total drawdown</h3>
        <span className="font-mono text-slate-300">{(ddPct*100).toFixed(2)}% / {(limit*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full bg-gradient-to-r ${tone} transition-all`} style={{ width: `${pct*100}%` }} />
      </div>
      {pct >= 0.8 && pct < 1 && <p className="mt-2 text-[11px] text-amber-400">Approaching drawdown limit.</p>}
      {pct >= 1 && <p className="mt-2 text-[11px] text-red-400">Drawdown limit breached — challenge fails on next evaluation.</p>}
    </div>
  );
}
