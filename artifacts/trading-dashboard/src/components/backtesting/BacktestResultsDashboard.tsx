// (P) Backtest results dashboard — KPIs for one run.

import { useQuery } from "@tanstack/react-query";

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
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

export function BacktestResultsDashboard({ runId }: { runId: number | null }) {
  const { data: run, isLoading } = useQuery<Run>({
    queryKey: ["backtest-run", runId],
    queryFn: async () => {
      const r = await fetch(`/api/backtest-runs/${runId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: runId != null,
  });
  if (!runId) return <p className="text-xs text-slate-500">Pick a run to see results.</p>;
  if (isLoading || !run) return <p className="text-xs text-slate-500">Loading…</p>;

  const verified = run.isVerified === "VERIFIED";
  // The verdict pill describes this BACKTEST run over HISTORICAL candles — it is
  // never a live-readiness signal. The tooltip makes that explicit so "VERIFIED"
  // can't be mistaken for "this market is live-confirmed / executable now".
  const verdictPill = verified
    ? <span className="rounded bg-green-700 px-2 py-0.5 text-[10px] font-semibold text-white" title="Backtest verdict over historical candles — not a live-readiness or execution signal.">VERIFIED</span>
    : run.status === "INSUFFICIENT_DATA"
      ? <span className="rounded bg-amber-700 px-2 py-0.5 text-[10px] font-semibold text-white" title="Not enough historical candles to verify this backtest run.">INSUFFICIENT DATA</span>
      : <span className="rounded bg-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-200" title="This backtest run has not been verified.">UNVERIFIED</span>;

  // PART B (Phase 2) — DISPLAY-only reliability badge. Reflects whether the run
  // had enough historical candle depth to trust the sample; never blocks a run.
  // Task #797 — honest data-source label: real broker history vs the
  // clearly-labeled synthetic generator. Display-only.
  const dataSourcePill = run.dataSource === "broker"
    ? <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-[10px] font-semibold text-emerald-300" title="Simulated over real closed broker bars from the durable broker candle store.">REAL BROKER DATA</span>
    : <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-400" title="Simulated over deterministic synthetic candles — no broker history was used.">SYNTHETIC DATA</span>;

  const dr = run.dataReliability;
  const reliabilityPill = dr
    ? dr.reliable
      ? <span
          className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-300"
          title={`${dr.availableClosedCandles} closed candles analysed (min ${dr.minimumRequiredCandles}).`}
        >DATA · {dr.availableClosedCandles} bars</span>
      : <span
          className="rounded bg-amber-700 px-2 py-0.5 text-[10px] font-semibold text-white"
          title={`Only ${dr.availableClosedCandles} closed candles (min ${dr.minimumRequiredCandles}). Thin sample — treat metrics with caution.`}
        >THIN DATA · {dr.availableClosedCandles} bars</span>
    : null;

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

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Trades" value={`${run.totalTrades}`} />
        <Stat label="Win rate" value={`${(run.winRate * 100).toFixed(1)}%`} tone={run.winRate >= 0.5 ? "good" : "bad"} />
        <Stat label="Net P&L" value={run.netProfitLoss.toFixed(2)} tone={run.netProfitLoss >= 0 ? "good" : "bad"} />
        <Stat label="Max DD" value={run.maxDrawdown.toFixed(2)} tone="bad" />
        <Stat label="Avg R:R" value={run.averageRr.toFixed(2)} />
        <Stat label="Expectancy" value={run.expectancy.toFixed(2)} tone={run.expectancy >= 0 ? "good" : "bad"} />
        <Stat label="Profit factor" value={run.profitFactor >= 999 ? "∞" : run.profitFactor.toFixed(2)} tone={run.profitFactor > 1 ? "good" : "bad"} />
        <Stat label="Wins / losses" value={`${run.winningTrades} / ${run.losingTrades}`} />
      </div>

      <p className="rounded-md border border-amber-700 bg-amber-950/30 p-2 text-[11px] text-amber-200">
        ⚠ Past performance does not guarantee future results. Backtests are historical simulations only.
      </p>
    </div>
  );
}
