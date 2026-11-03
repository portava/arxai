// The evaluator measures drawdown from the running balance of CLOSED paper
// trades (paper_orders on the challenge's paper account, not an MT5 demo
// account); open positions are not marked to market. The meter says so, and
// how many open positions were left out, instead of reading as equity drawdown.
export function ClosedTradeBasisNote({ openPositions, testId }: { openPositions?: number | null; testId: string }) {
  const n = typeof openPositions === "number" && Number.isFinite(openPositions) ? openPositions : null;
  return (
    <p className="mt-2 text-[11px] text-slate-400" data-testid={testId}>
      From closed paper trades only. Open positions&rsquo; floating P&amp;L is not counted.
      {n != null && n > 0 && (
        <span className="text-amber-400"> {n === 1 ? "1 open position is" : `${n} open positions are`} not counted.</span>
      )}
      {n == null && <span> Open positions could not be checked.</span>}
    </p>
  );
}

// Breach / warning thresholds mirror the evaluator in api-server
// routes/propChallenges.ts: a HARD violation only when the value is strictly
// ABOVE the limit, and a warning only when it is strictly above 80% of it.
// Exactly at the limit the challenge is still ACTIVE, so it is not "breached".
export function PropDrawdownMeter({ ddPct, limit, openPositions }: { ddPct: number; limit: number; openPositions?: number | null }) {
  const pct = Math.max(0, Math.min(1, ddPct / limit));
  const breached = ddPct > limit;
  const atLimit = !breached && ddPct >= limit;
  const approaching = !breached && !atLimit && ddPct > limit * 0.8;
  const tone = breached ? "from-red-700 to-red-500" : atLimit || approaching ? "from-amber-600 to-amber-400" : "from-slate-600 to-slate-400";
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <h3 className="font-semibold text-slate-100">Closed-trade drawdown</h3>
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
      <ClosedTradeBasisNote openPositions={openPositions} testId="prop-drawdown-basis" />
    </div>
  );
}
