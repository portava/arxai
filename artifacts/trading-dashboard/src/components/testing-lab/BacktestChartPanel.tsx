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
      <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted">
        Select a run to see its equity curve.
      </p>
    );
  }
  if (isLoading) {
    return <p className="rounded border border-border bg-muted/40 p-6 text-center text-xs text-txt-muted">Loading chart…</p>;
  }
  if (isError || !data) {
    return <p className="rounded border border-danger/50 bg-danger/20 p-6 text-center text-xs text-danger">Could not load the chart series for this run.</p>;
  }
  // Focus-Lock blocked envelope — the run's symbol is no longer ARX-approved.
  if ("blocked" in data && (data as { blocked?: boolean }).blocked) {
    return <p className="rounded border border-warning/50 bg-warning/20 p-6 text-center text-xs text-warning">This run's market is outside ARX Focus and cannot be charted.</p>;
  }

  const points = data.equity as EquityPoint[];
  const net = data.finalBalance - data.initialBalance;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Equity & drawdown</h3>
        <span className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-txt-secondary">
          {data.label}
        </span>
      </div>
      <div className="grid gap-2 text-xs text-txt-secondary sm:grid-cols-3">
        <span>Start <span className="font-mono text-foreground">${data.initialBalance.toFixed(2)}</span></span>
        <span>End <span className="font-mono text-foreground">${data.finalBalance.toFixed(2)}</span></span>
        <span>Net <span className={`font-mono ${net >= 0 ? "text-success" : "text-danger"}`}>{net >= 0 ? "+" : ""}{net.toFixed(2)}</span></span>
      </div>
      <EquityCurveChart points={points} />
      <DrawdownChart points={points} maxDrawdown={data.maxDrawdown} />
      <p className="text-[10px] text-txt-muted">
        Historical simulation only. Past performance does not guarantee future results.
      </p>
    </div>
  );
}
