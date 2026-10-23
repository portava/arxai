// Testing Lab — backtest equity-curve + drawdown chart panel (Task #763).
// DISPLAY-ONLY. Reads GET /api/backtest-runs/:id/chart-series, which derives the
// curve from the run's stored initialBalance + per-trade profitLoss. No
// execution path. The provenance label is explicit: a backtest is a historical
// simulation, never live performance.

import { useQuery } from "@tanstack/react-query";
import { EquityCurveChart, DrawdownChart, type EquityPoint } from "@/components/analytics";
import type { BacktestChartSeries } from "@workspace/api-client-react";

export function BacktestChartPanel({ runId }: { runId: number | null }) {
  const { data, isLoading, isError } = useQuery<BacktestChartSeries>({
    queryKey: ["backtest-chart-series", runId],
    enabled: runId != null,
    queryFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}/chart-series`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  if (runId == null) {
    return (
      <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500">
        Select a run to see its equity curve.
      </p>
    );
  }
  if (isLoading) {
    return <p className="rounded border border-slate-700 bg-slate-900/40 p-6 text-center text-xs text-slate-500">Loading chart…</p>;
  }
  if (isError || !data) {
    return <p className="rounded border border-red-900/50 bg-red-950/20 p-6 text-center text-xs text-red-300">Could not load the chart series for this run.</p>;
  }
  // Focus-Lock blocked envelope — the run's symbol is no longer ARX-approved.
  if ("blocked" in data && (data as { blocked?: boolean }).blocked) {
    return <p className="rounded border border-amber-900/50 bg-amber-950/20 p-6 text-center text-xs text-amber-300">This run's market is outside ARX Focus and cannot be charted.</p>;
  }

  const points = data.equity as EquityPoint[];
  const net = data.finalBalance - data.initialBalance;
  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Equity & drawdown</h3>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
          {data.label}
        </span>
      </div>
      <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
        <span>Start <span className="font-mono text-slate-200">${data.initialBalance.toFixed(2)}</span></span>
        <span>End <span className="font-mono text-slate-200">${data.finalBalance.toFixed(2)}</span></span>
        <span>Net <span className={`font-mono ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{net >= 0 ? "+" : ""}{net.toFixed(2)}</span></span>
      </div>
      <EquityCurveChart points={points} />
      <DrawdownChart points={points} maxDrawdown={data.maxDrawdown} />
      <p className="text-[10px] text-slate-500">
        Historical simulation only. Past performance does not guarantee future results.
      </p>
    </div>
  );
}
