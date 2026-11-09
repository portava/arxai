// (P) Backtest results dashboard — KPIs for one run.

import { useQuery } from "@tanstack/react-query";
import { backtestSourceLabel, backtestEvidence, formatBacktestPriceUnits, formatBacktestNumber, formatBacktestPercent, formatBacktestProfitFactor } from "@workspace/domain/backtest";
import { BACKTEST_NOT_MEASURED, backtestMetricsUnmeasured } from "./backtestRunMeasurement";

interface DataReliability {
  status: "sufficient" | "partial" | "insufficient" | "blocked";
  availableClosedCandles: number;
  minimumRequiredCandles: number;
  reliable: boolean;
}

interface Run {
  id: number; strategyId: string; symbol: string; timeframe: string;
  initialBalance: number;
  totalTrades: number; winningTrades: number; losingTrades: number;
  netProfitLoss: number; maxDrawdown: number; winRate: number;
  averageRr: number; expectancy: number; profitFactor: number;
  status: string; isVerified: string; aiSummary: string | null;
  // "broker" (real broker_candles history) | "synthetic" (labeled generator).
  dataSource?: string;
  createdAt: string;
  // PART B (Phase 2) — DISPLAY-only data-reliability verdict, composed from the
  // shared sufficiency engine over the run's historical candle depth. Never a
  // block; it only describes how trustworthy the sample size is.
  dataReliability?: DataReliability;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  if (value.startsWith("Unavailable") || value === BACKTEST_NOT_MEASURED) tone = undefined;
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

export function BacktestResultsDashboard({ runId }: { runId: number | null }) {
  const { data: run, isLoading, isError } = useQuery<Run>({
    queryKey: ["backtest-run", runId],
    queryFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: runId != null,
  });
  if (!runId) return <p className="text-xs text-slate-500">Pick a run to see results.</p>;
  if (isLoading) return <p className="text-xs text-slate-500">Loading…</p>;
  if (isError || !run) return <p className="text-xs text-amber-300">Results unavailable for this run.</p>;

  const evidence = backtestEvidence(run.dataSource);
  // No completed simulated trades → the stored metric zeros are schema
  // defaults, not observations. Never colour or print them as a result.
  const unmeasured = backtestMetricsUnmeasured(run);
  const verdictPill = <span className="rounded bg-amber-900/50 px-2 py-0.5 text-[10px] font-semibold text-amber-200">{run.status === "INSUFFICIENT_DATA" ? "INSUFFICIENT DATA" : "DIAGNOSTIC ONLY"}</span>;
  const dataSourcePill = <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{backtestSourceLabel(run.dataSource)}</span>;

  // Depth pill. It must describe what the candles actually were:
  //   - generated prices: the count is the length of a generated series, not
  //     observed market depth, so it can never read as reliable "DATA";
  //   - no recorded depth (broker history is mutable and the run kept no
  //     snapshot): say the depth is not recorded rather than render nothing;
  //   - a run that produced no completed trades never gets the reliable pill.
  const dr = run.dataReliability;
  const neutralPill = "rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-300";
  const reliabilityPill = !dr
    ? <span
        className={neutralPill}
        title="The number of history bars this run used was not recorded, and today's candle store cannot reconstruct it."
      >DEPTH NOT RECORDED</span>
    : run.dataSource === "synthetic"
      ? <span
          className={neutralPill}
          title={`${dr.availableClosedCandles} candles simulated. Prices were generated, not observed market history, so this count says nothing about real data depth.`}
        >GENERATED · {dr.availableClosedCandles} bars</span>
      : !dr.reliable
        ? <span
            className="rounded bg-amber-700 px-2 py-0.5 text-[10px] font-semibold text-white"
            title={`Only ${dr.availableClosedCandles} closed candles (min ${dr.minimumRequiredCandles}). Thin sample — treat metrics with caution.`}
          >THIN DATA · {dr.availableClosedCandles} bars</span>
        : run.status === "INSUFFICIENT_DATA"
          ? <span
              className={neutralPill}
              title={`${dr.availableClosedCandles} closed candles analysed, but the run produced no completed simulated trades.`}
            >{dr.availableClosedCandles} bars</span>
          : <span
              className={neutralPill}
              title={`${dr.availableClosedCandles} closed candles analysed (min ${dr.minimumRequiredCandles}).`}
            >DATA · {dr.availableClosedCandles} bars</span>;

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{run.strategyId} · {run.symbol} · {run.timeframe}</h3>
          <p className="text-xs text-slate-500">{new Date(run.createdAt).toLocaleString()}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dataSourcePill}
          {reliabilityPill}
          {verdictPill}
        </div>
      </header>

      {unmeasured ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Trades" value="None completed" />
          <Stat label="Win rate" value={BACKTEST_NOT_MEASURED} />
          <Stat label="Gross P&L (price units)" value={BACKTEST_NOT_MEASURED} />
          <Stat label="Max DD (price units)" value={BACKTEST_NOT_MEASURED} />
          <Stat label="Avg R:R" value={BACKTEST_NOT_MEASURED} />
          <Stat label="Expectancy (price units)" value={BACKTEST_NOT_MEASURED} />
          <Stat label="Profit factor" value={BACKTEST_NOT_MEASURED} />
          <Stat label="Wins / losses" value={BACKTEST_NOT_MEASURED} />
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Trades" value={formatBacktestNumber(run.totalTrades)} />
        <Stat label="Win rate" value={formatBacktestPercent(run.winRate)} tone={run.winRate >= 0.5 ? "good" : "bad"} />
        <Stat label="Gross P&L (price units)" value={formatBacktestPriceUnits(run.netProfitLoss)} tone={run.netProfitLoss >= 0 ? "good" : "bad"} />
        <Stat label="Max DD (price units)" value={formatBacktestPriceUnits(run.maxDrawdown)} tone="bad" />
        <Stat label="Avg R:R" value={formatBacktestNumber(run.averageRr)} />
        <Stat label="Expectancy (price units)" value={formatBacktestPriceUnits(run.expectancy)} tone={run.expectancy >= 0 ? "good" : "bad"} />
        <Stat label="Profit factor" value={formatBacktestProfitFactor(run.profitFactor)} tone={run.profitFactor > 1 ? "good" : "bad"} />
        <Stat label="Wins / losses" value={`${formatBacktestNumber(run.winningTrades)} / ${formatBacktestNumber(run.losingTrades)}`} />
      </div>
      )}
      {unmeasured && (
        <p className="text-[11px] text-slate-400">
          No completed simulated trades in this run, so win rate, P&amp;L, drawdown, expectancy and profit factor were not measured. The stored zeros are placeholders, not results.
        </p>
      )}

      <p className="rounded-md border border-amber-700 bg-amber-950/30 p-2 text-[11px] text-amber-200">
        {evidence.limitations.join(" ")} Past performance does not guarantee future results.
      </p>
    </div>
  );
}
