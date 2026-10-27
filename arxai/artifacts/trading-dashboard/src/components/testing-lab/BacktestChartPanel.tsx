// Testing Lab — backtest equity-curve + drawdown chart panel (Task #763).
// DISPLAY-ONLY. Reads GET /api/backtest-runs/:id/chart-series, which derives the
// zero-origin gross curve from the run's per-trade profitLoss. No
// execution path. The provenance label is explicit: a backtest is a historical
// simulation, never live performance.

import { useQuery } from "@tanstack/react-query";
import { EquityCurveChart, DrawdownChart, type EquityPoint } from "@/components/analytics";
import { formatBacktestPriceUnits } from "@workspace/domain/backtest";
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

  if (!Array.isArray(data.equity) || !data.equity.every((point) => point != null && typeof point.grossPriceUnits === "number" && Number.isFinite(point.grossPriceUnits)
    && typeof point.peakGrossPriceUnits === "number" && Number.isFinite(point.peakGrossPriceUnits))) {
    return <p className="text-xs text-amber-300">Precise price-unit curve unavailable. Reload this run from the updated service.</p>;
  }
  const points: EquityPoint[] = data.equity.map((point) => ({ ...point, equity: point.grossPriceUnits!, peak: point.peakGrossPriceUnits! }));
  const net = data.summary?.netProfitLoss;
  const hasNet = typeof net === "number" && Number.isFinite(net);
  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Gross P&L & drawdown</h3>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
          Diagnostic simulation · price units
        </span>
      </div>
      <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
        <span>Start <span className="font-mono text-slate-200">0 price units</span></span>
        <span>End <span className="font-mono text-slate-200">{formatBacktestPriceUnits(net)} price units</span></span>
        <span>Net <span className={`font-mono ${!hasNet ? "text-slate-400" : net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{hasNet && net >= 0 ? "+" : ""}{formatBacktestPriceUnits(net)}</span></span>
      </div>
      <EquityCurveChart points={points} title="Gross P&L (price units)" />
      <DrawdownChart points={points} maxDrawdown={data.maxDrawdown} unit="price units" />
      <p className="text-[10px] text-slate-500">
        Diagnostic curve in unscaled price units, before trading costs. The curve starts at zero and represents no account currency. Past performance does not guarantee future results.
      </p>
    </div>
  );
}
