// Testing Lab — Backtesting tab. Reuses the existing backtest component suite
// against the real /api/backtest-runs engine. The strategy selection is lifted
// to the Testing Lab page so it persists across tabs (shared strategy selector).

import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { backtestSourceLabel, formatBacktestPriceUnits, formatBacktestNumber, formatBacktestPercent, formatBacktestProfitFactor } from "@workspace/domain/backtest";
import {
  StrategyBacktestForm, BacktestResultsDashboard,
  BacktestTradeList, AIBacktestReviewCard,
} from "@/components/backtesting";
import { BacktestChartPanel } from "./BacktestChartPanel";
import type { BacktestRunRow } from "./types";

export function BacktestingTab({
  strategyId,
  onStrategyChange,
}: {
  strategyId?: string;
  onStrategyChange?: (s: string) => void;
}) {
  const [runId, setRunId] = useState<number | null>(null);
  const { data, isLoading, isError } = useQuery<{ runs: BacktestRunRow[] }>({
    queryKey: ["backtest-runs"],
    queryFn: async () => {
      const r = await fetch("/api/backtest-runs?limit=50");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const unavailable = isError || !Array.isArray(data?.runs);
  const visibleRuns = (unavailable ? [] : data!.runs).filter((run) => !strategyId || run.strategyId === strategyId);
  useLayoutEffect(() => setRunId(null), [strategyId]);
  return (
    <div className="space-y-4 pt-2">
      <p className="text-xs text-slate-500">
        Explore diagnostic simulations. Prices may be generated or taken from
        unattested broker history; costs and holdouts are not modelled.
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-1">
          <StrategyBacktestForm
            onCreated={setRunId}
            strategyId={strategyId}
            onStrategyChange={onStrategyChange}
          />
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <h3 className="mb-2 text-sm font-semibold text-slate-100">Recent runs</h3>
            <div className="max-h-72 space-y-1 overflow-auto">
              {visibleRuns.map((r) => (
                <button key={r.id} onClick={() => setRunId(r.id)}
                  className={`block w-full rounded border border-slate-800 bg-slate-950/40 p-2 text-left text-xs hover:bg-slate-900 ${runId === r.id ? "ring-1 ring-indigo-500" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-slate-200">{r.strategyId} · {r.symbol}</span>
                    <span className="flex items-center gap-1">
                      <span className="text-[9px] text-slate-400">{backtestSourceLabel(r.dataSource)}</span>
                      <span className="text-[10px] text-amber-300">DIAGNOSTIC</span>
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    {formatBacktestNumber(r.totalTrades)} trades · WR {formatBacktestPercent(r.winRate)} · PF {formatBacktestProfitFactor(r.profitFactor)} · gross {formatBacktestPriceUnits(r.netProfitLoss)} price units
                  </div>
                </button>
              ))}
              {isLoading ? <p className="text-xs text-slate-500">Loading recent runs…</p>
                : unavailable ? <p className="text-xs text-amber-300">Recent runs unavailable.</p>
                : visibleRuns.length === 0 && <p className="text-xs text-slate-500">No runs yet.</p>}
            </div>
          </div>
        </div>
        <div className="space-y-3 lg:col-span-2">
          <BacktestResultsDashboard runId={runId} />
          <BacktestChartPanel runId={runId} />
          <AIBacktestReviewCard runId={runId} />
          <BacktestTradeList runId={runId} />
        </div>
      </div>
    </div>
  );
}
