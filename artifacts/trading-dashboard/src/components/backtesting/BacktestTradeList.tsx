// (P) Per-trade list for a backtest run.

import { useQuery } from "@tanstack/react-query";

interface Trade {
  id: number; symbol: string; direction: string;
  entryTime: string; exitTime: string;
  entryPrice: number; exitPrice: number;
  stopLoss: number; takeProfit: number;
  profitLoss: number; rewardToRisk: number;
  result: string;
}

export function BacktestTradeList({ runId }: { runId: number | null }) {
  const { data, isLoading } = useQuery<{ trades: Trade[] }>({
    queryKey: ["backtest-trades", runId],
    queryFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}/trades`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: runId != null,
  });
  if (!runId) return null;
  if (isLoading) return <p className="text-xs text-slate-500">Loading trades…</p>;
  const trades = data?.trades ?? [];
  if (trades.length === 0) return <p className="text-xs text-slate-500">No trades produced by this run.</p>;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Trades ({trades.length})</h3>
      <div className="max-h-80 overflow-auto text-xs">
        <table className="w-full">
          <thead className="sticky top-0 bg-slate-900 text-left text-[10px] uppercase text-slate-500">
            <tr>
              <th className="p-1">#</th><th className="p-1">Dir</th><th className="p-1">Entry</th><th className="p-1">Exit</th>
              <th className="p-1">P&L</th><th className="p-1">R:R</th><th className="p-1">Result</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={t.id} className="border-t border-slate-800">
                <td className="p-1 text-slate-500">{i + 1}</td>
                <td className="p-1">{t.direction}</td>
                <td className="p-1 font-mono">{t.entryPrice.toFixed(4)}</td>
                <td className="p-1 font-mono">{t.exitPrice.toFixed(4)}</td>
                <td className={`p-1 font-mono ${t.profitLoss >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {t.profitLoss >= 0 ? "+" : ""}{t.profitLoss.toFixed(4)}
                </td>
                <td className="p-1">{t.rewardToRisk.toFixed(2)}</td>
                <td className="p-1">
                  <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${t.result === "WIN" ? "bg-green-700 text-white" : t.result === "LOSS" ? "bg-red-700 text-white" : "bg-slate-700 text-slate-200"}`}>
                    {t.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
