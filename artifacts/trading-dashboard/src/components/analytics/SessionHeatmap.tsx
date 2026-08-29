type SessionData = Record<string, { trades: number; pnl: number; wins: number }>;

export function SessionHeatmap({ data }: { data: SessionData }) {
  const sessions = ["ASIA", "LONDON", "NEWYORK"] as const;
  const max = Math.max(...sessions.map((s) => Math.abs(data[s]?.pnl ?? 0)), 1);
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Session Heatmap</h3>
      <div className="grid grid-cols-3 gap-2">
        {sessions.map((s) => {
          const d = data[s] ?? { trades: 0, pnl: 0, wins: 0 };
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
                {d.trades} trades · {d.trades ? Math.round((d.wins / d.trades) * 100) : 0}% win
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
