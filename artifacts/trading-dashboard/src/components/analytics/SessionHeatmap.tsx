/**
 * One session bucket from GET /api/analytics/session. `pnl` sums only the
 * trades that could be sized in USD; `sizedTrades` says how many (absent on
 * an older server: then every trade is taken as sized). `wins` counts
 * favourable price moves, sized or not.
 */
type SessionBucket = { trades: number; pnl: number; wins: number; sizedTrades?: number };
type SessionData = Record<string, SessionBucket>;

const NEUTRAL_TONE = "rgba(51,65,85,0.35)";

// "No trades" only for a bucket the loaded response reported with 0 trades:
// while loading, or when the results (or a bucket) are missing from the
// response, nothing was observed, so no cell claims an empty session.
export function SessionHeatmap({ data, basis, loading = false }: { data: SessionData | null | undefined; basis?: string; loading?: boolean }) {
  const sessions = ["ASIA", "LONDON", "NEWYORK"] as const;
  if (loading || !data) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">Session Heatmap</h3>
        <p data-testid="session-heatmap-state" className="p-3 text-center text-[11px] text-slate-500">
          {loading ? "Loading session results…" : "The session results were missing from the response, so they cannot be shown."}
        </p>
      </div>
    );
  }
  // A session's P&L is measured only when it has trades and at least one of
  // them could be sized; the colour scale uses only measured sessions.
  const measured = (d: SessionBucket) => d.trades > 0 && (d.sizedTrades == null || d.sizedTrades > 0);
  const max = Math.max(...sessions.map((s) => {
    const d = data[s];
    return d && measured(d) ? Math.abs(d.pnl) : 0;
  }), 1);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Session Heatmap</h3>
      <div className="grid grid-cols-3 gap-2">
        {sessions.map((s) => {
          const reported = data[s];
          // A bucket missing from the response was not observed: never "No trades".
          if (!reported) {
            return (
              <div key={s} className="rounded border border-slate-700 p-2 text-center" data-testid={`session-cell-${s}`}
                style={{ backgroundColor: NEUTRAL_TONE }}>
                <div className="text-[10px] uppercase tracking-wide text-slate-100/80">{s}</div>
                <div className="text-base font-bold text-slate-400">—</div>
                <div className="text-[10px] text-slate-100/70">Not reported</div>
              </div>
            );
          }
          const d: SessionBucket = reported;
          // No trade → no result; trades none of which could be sized → no
          // P&L. Neither is a $0 or 0% cell.
          const isMeasured = measured(d);
          const partlySized = isMeasured && d.sizedTrades != null && d.sizedTrades < d.trades;
          const intensity = isMeasured ? Math.abs(d.pnl) / max : 0;
          const tone = !isMeasured
            ? NEUTRAL_TONE
            : d.pnl >= 0
              ? `rgba(16,185,129,${0.15 + intensity * 0.65})`
              : `rgba(239,68,68,${0.15 + intensity * 0.65})`;
          return (
            <div key={s} className="rounded border border-slate-700 p-2 text-center" data-testid={`session-cell-${s}`}
              style={{ backgroundColor: tone }}>
              <div className="text-[10px] uppercase tracking-wide text-slate-100/80">{s}</div>
              {d.trades === 0 ? (
                <>
                  <div className="text-base font-bold text-slate-400">—</div>
                  <div className="text-[10px] text-slate-100/70">No trades</div>
                </>
              ) : (
                <>
                  <div className={`text-base font-bold ${!isMeasured ? "text-slate-400" : d.pnl >= 0 ? "text-emerald-100" : "text-red-100"}`}>
                    {isMeasured ? `$${d.pnl.toFixed(0)}` : "not measured"}
                  </div>
                  <div className="text-[10px] text-slate-100/70">
                    {`${d.trades} ${d.trades === 1 ? "trade" : "trades"} · ${Math.round((d.wins / d.trades) * 100)}% win`}
                  </div>
                  {!isMeasured && (
                    <div className="text-[10px] text-slate-100/70">P&amp;L not sized: none of its trades could be sized in USD</div>
                  )}
                  {partlySized && (
                    <div className="text-[10px] text-slate-100/70">{d.sizedTrades} of {d.trades} trades sized</div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {basis ? <p className="mt-2 text-[10px] text-slate-500" data-testid="session-basis">{basis}</p> : null}
    </div>
  );
}
