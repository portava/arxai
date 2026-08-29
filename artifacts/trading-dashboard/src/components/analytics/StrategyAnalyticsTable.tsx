import type { StrategyRow } from "./types";

export function StrategyAnalyticsTable({ rows }: { rows: StrategyRow[] }) {
  if (rows.length === 0) return <p className="rounded border border-dashed border-border p-3 text-center text-[11px] text-txt-muted">No strategy data.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-muted/40">
      <table className="w-full text-xs text-foreground">
        <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-txt-secondary">
          <tr>
            <th className="px-2 py-1.5 text-left">Symbol</th>
            <th className="px-2 py-1.5 text-right">Trades</th>
            <th className="px-2 py-1.5 text-right">Win %</th>
            <th className="px-2 py-1.5 text-right">Avg RR</th>
            <th className="px-2 py-1.5 text-right">Expectancy</th>
            <th className="px-2 py-1.5 text-right">Total P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-t border-border">
              <td className="px-2 py-1.5 font-semibold">{r.symbol}</td>
              <td className="px-2 py-1.5 text-right">{r.trades}</td>
              <td className="px-2 py-1.5 text-right">{(r.winRate * 100).toFixed(1)}%</td>
              <td className="px-2 py-1.5 text-right">{r.averageRr.toFixed(2)}R</td>
              <td className={`px-2 py-1.5 text-right ${r.expectancy >= 0 ? "text-success" : "text-danger"}`}>
                ${r.expectancy.toFixed(2)}
              </td>
              <td className={`px-2 py-1.5 text-right font-semibold ${r.totalPnl >= 0 ? "text-success" : "text-danger"}`}>
                ${r.totalPnl.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
