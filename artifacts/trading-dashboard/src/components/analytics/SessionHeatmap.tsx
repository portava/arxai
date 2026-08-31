type SessionData = Record<string, { trades: number; pnl: number; wins: number }>;

export function SessionHeatmap({ data, isLoading, isError }: {
  // null = the read did not deliver a usable session dataset (pending body,
  // error body, missing key). Never substitute {} — an empty object renders
  // as a fully-populated "$0 / 0 trades" grid indistinguishable from a real
  // flat result.
  data: SessionData | null;
  isLoading?: boolean;
  isError?: boolean;
}) {
  const sessions = ["ASIA", "LONDON", "NEWYORK"] as const;

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <h3 className="mb-2 text-sm font-semibold text-foreground">Session Heatmap</h3>
        <p className="py-6 text-center text-xs text-txt-muted" data-testid="session-heatmap-loading">
          Loading session data…
        </p>
      </div>
    );
  }

  // A failed or empty read must be visually distinct from a real flat result:
  // no per-session grid, no $ figures, no win % — a labeled unknown instead.
  if (isError || data == null) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
        <h3 className="mb-2 text-sm font-semibold text-foreground">Session Heatmap</h3>
        <p className="py-6 text-center text-xs font-medium text-warning" data-testid="session-heatmap-error">
          Couldn&apos;t load session data — showing nothing rather than guessing.
        </p>
      </div>
    );
  }

  const max = Math.max(...sessions.map((s) => Math.abs(data[s]?.pnl ?? 0)), 1);
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Session Heatmap</h3>
      <div className="grid grid-cols-3 gap-2">
        {sessions.map((s) => {
          const d = data[s];
          // Zero trades in a session = no measurement exists for it. "$0 /
          // 0% win" would assert a flat, all-losing result that was never
          // measured — render an explicit "no trades" cell instead.
          if (!d || d.trades === 0) {
            return (
              <div key={s} className="rounded border border-border bg-background/30 p-2 text-center"
                data-testid={`session-empty-${s}`}>
                <div className="text-[10px] uppercase tracking-wide text-foreground/80">{s}</div>
                <div className="text-base font-bold text-txt-muted">—</div>
                <div className="text-[10px] text-txt-muted">No trades</div>
              </div>
            );
          }
          const intensity = Math.abs(d.pnl) / max;
          const tone = d.pnl >= 0
            ? `rgba(16,185,129,${0.15 + intensity * 0.65})`
            : `rgba(239,68,68,${0.15 + intensity * 0.65})`;
          return (
            <div key={s} className="rounded border border-border p-2 text-center"
              style={{ backgroundColor: tone }}>
              <div className="text-[10px] uppercase tracking-wide text-foreground/80">{s}</div>
              <div className={`text-base font-bold ${d.pnl >= 0 ? "text-success" : "text-danger"}`}>
                ${d.pnl.toFixed(0)}
              </div>
              <div className="text-[10px] text-foreground/70">
                {d.trades} trades · {Math.round((d.wins / d.trades) * 100)}% win
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
