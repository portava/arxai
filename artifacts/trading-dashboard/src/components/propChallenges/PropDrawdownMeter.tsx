// Breach / warning thresholds mirror the evaluator in api-server
// routes/propChallenges.ts: a HARD violation only when the value is strictly
// ABOVE the limit, and a warning only when it is strictly above 80% of it.
// Exactly at the limit the challenge is still ACTIVE, so it is not "breached".
export function PropDrawdownMeter({ ddPct, limit }: { ddPct: number; limit: number }) {
  const pct = Math.max(0, Math.min(1, ddPct / limit));
  const breached = ddPct > limit;
  const atLimit = !breached && ddPct >= limit;
  const approaching = !breached && !atLimit && ddPct > limit * 0.8;
  const tone = breached ? "from-red-700 to-red-500" : atLimit || approaching ? "from-amber-600 to-amber-400" : "from-slate-600 to-slate-400";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-slate-100">Total drawdown</h3>
        <span className="font-mono text-slate-300">{(ddPct*100).toFixed(2)}% / {(limit*100).toFixed(0)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full bg-gradient-to-r ${tone} transition-all`} style={{ width: `${pct*100}%` }} />
      </div>
      {approaching && <p data-testid="text-drawdown-state" className="mt-2 text-[11px] text-amber-400">Approaching drawdown limit.</p>}
      {atLimit && (
        <p data-testid="text-drawdown-state" className="mt-2 text-[11px] text-amber-400">
          At the drawdown limit. The challenge fails only if drawdown goes above it.
        </p>
      )}
      {breached && <p data-testid="text-drawdown-state" className="mt-2 text-[11px] text-red-400">Drawdown limit breached — challenge fails on next evaluation.</p>}
    </div>
  );
}
