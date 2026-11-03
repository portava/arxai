import type { StrategyRow } from "./types";

/** What the strategy read covered (GET /analytics/strategy pnlCoverage). */
export interface StrategyCoverage {
  closedTrades: number;
  sizedTrades: number;
  unsizedTrades: number;
  unsizedSymbols: string[];
}

/**
 * Why there is no row. Rows group only trades sized in USD, so an empty table
 * says "no closed trades" only when the server confirmed there are none.
 */
function emptyText(coverage: StrategyCoverage | null | undefined, loading: boolean): string {
  if (loading) return "Loading results by symbol…";
  if (!coverage) return "No closed trade sized in USD to group by symbol.";
  if (coverage.closedTrades === 0) return "No closed trades to group by symbol.";
  const n = coverage.closedTrades;
  const symbols = coverage.unsizedSymbols.length ? ` (${coverage.unsizedSymbols.join(", ")})` : "";
  return `None of your ${n} closed ${n === 1 ? "trade" : "trades"} could be sized in USD${symbols}, so there are no results by symbol.`;
}

export function StrategyAnalyticsTable({ rows, coverage, loading = false }: {
  rows: StrategyRow[];
  coverage?: StrategyCoverage | null;
  loading?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p data-testid="strategy-table-empty" className="rounded border border-dashed border-slate-700 p-3 text-center text-[11px] text-slate-500">
        {emptyText(coverage, loading)}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-900/40">
      <table className="w-full text-xs text-slate-200">
        <thead className="bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
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
            <tr key={r.symbol} className="border-t border-slate-800">
              <td className="px-2 py-1.5 font-semibold">{r.symbol}</td>
              <td className="px-2 py-1.5 text-right">{r.trades}</td>
              <td className="px-2 py-1.5 text-right">{(r.winRate * 100).toFixed(1)}%</td>
              <td className="px-2 py-1.5 text-right">{r.averageRr.toFixed(2)}R</td>
              <td className={`px-2 py-1.5 text-right ${r.expectancy >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                ${r.expectancy.toFixed(2)}
              </td>
              <td className={`px-2 py-1.5 text-right font-semibold ${r.totalPnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                ${r.totalPnl.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
