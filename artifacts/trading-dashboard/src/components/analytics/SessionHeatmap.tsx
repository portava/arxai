// sizedTrades: trades in the bucket whose P&L could be sized in USD (pnl sums
// only those). Older servers omit it; then every trade is taken as sized.
type SessionData = Record<string, { trades: number; pnl: number; wins: number; sizedTrades?: number }>;

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
  const sizedOf = (d: { trades: number; sizedTrades?: number }) => d.sizedTrades ?? d.trades;
  const max = Math.max(...sessions.map((s) => {
    const d = data[s];
    return d && d.trades > 0 && sizedOf(d) > 0 ? Math.abs(d.pnl) : 0;
  }), 1);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Session Heatmap</h3>
      <div className="grid grid-cols-3 gap-2">
        {sessions.map((s) => {
          const reported = data[s];
          if (!reported) {
            return (
              <div key={s} className="rounded border border-slate-700 p-2 text-center" data-testid={`session-cell-${s}`}
                style={{ backgroundColor: "rgba(51,65,85,0.35)" }}>
                <div className="text-[10px] uppercase tracking-wide text-slate-100/80">{s}</div>
                <div className="text-base font-bold text-slate-400">—</div>
                <div className="text-[10px] text-slate-100/70">Not reported</div>
              </div>
            );
          }
          const d = reported;
          // No trade → no result; trades none of which could be sized → no
          // P&L. Neither is a $0 or 0% cell.
          const hasPnl = d.trades > 0 && sizedOf(d) > 0;
          const intensity = hasPnl ? Math.abs(d.pnl) / max : 0;
          const tone = !hasPnl
            ? "rgba(51,65,85,0.35)"
            : d.pnl >= 0
              ? `rgba(16,185,129,${0.15 + intensity * 0.65})`
              : `rgba(239,68,68,${0.15 + intensity * 0.65})`;
          return (
            <div key={s} className="rounded border border-slate-700 p-2 text-center" data-testid={`session-cell-${s}`}
              style={{ backgroundColor: tone }}>
              <div className="text-[10px] uppercase tracking-wide text-slate-100/80">{s}</div>
              <div className={`text-base font-bold ${!hasPnl ? "text-slate-400" : d.pnl >= 0 ? "text-emerald-100" : "text-red-100"}`}>
                {hasPnl ? `$${d.pnl.toFixed(0)}` : "—"}
              </div>
              <div className="text-[10px] text-slate-100/70">
                {d.trades === 0
                  ? "No trades"
                  : `${d.trades} ${d.trades === 1 ? "trade" : "trades"} · ${Math.round((d.wins / d.trades) * 100)}% win${hasPnl ? "" : " · P&L not sized"}`}
              </div>
            </div>
          );
        })}
      </div>
      {basis ? <p className="mt-2 text-[10px] text-slate-500" data-testid="session-basis">{basis}</p> : null}
    </div>
  );
}
