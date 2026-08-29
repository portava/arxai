// Testing Lab — Backtesting tab. Reuses the existing backtest component suite
// against the real /api/backtest-runs engine. The strategy selection is lifted
// to the Testing Lab page so it persists across tabs (shared strategy selector).

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
  const { data } = useQuery<{ runs: BacktestRunRow[] }>({
    queryKey: ["backtest-runs"],
    queryFn: async () => {
      const r = await fetch("/api/backtest-runs?limit=50");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  return (
    <div className="space-y-4 pt-2">
      <p className="text-xs text-txt-muted">
        Test strategies against historical candles. Past performance does not
        guarantee future results.
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-1">
          <StrategyBacktestForm
            onCreated={setRunId}
            strategyId={strategyId}
            onStrategyChange={onStrategyChange}
          />
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Recent runs</h3>
            <div className="max-h-72 space-y-1 overflow-auto">
              {(data?.runs ?? []).map((r) => (
                <button key={r.id} onClick={() => setRunId(r.id)}
                  className={`block w-full rounded border border-border bg-background/40 p-2 text-left text-xs hover:bg-card ${runId === r.id ? "ring-1 ring-primary" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-foreground">{r.strategyId} · {r.symbol}</span>
                    <span className="flex items-center gap-1">
                      {r.dataSource === "broker"
                        ? <span className="rounded bg-success/60 px-1 py-0.5 text-[9px] font-semibold text-success" title="Simulated over real closed broker bars.">REAL BROKER DATA</span>
                        : <span className="rounded bg-secondary px-1 py-0.5 text-[9px] font-semibold text-txt-secondary" title="Simulated over deterministic synthetic candles — no broker history was used.">SYNTHETIC</span>}
                      <span
                        title={r.isVerified === "SYNTHETIC_NOT_VERIFIABLE"
                          ? "Fabricated candles — a verification verdict is not possible from this run."
                          : undefined}
                        className={`text-[10px] ${r.isVerified === "VERIFIED" ? "text-success" : r.status === "INSUFFICIENT_DATA" ? "text-warning" : "text-txt-muted"}`}
                      >{r.isVerified === "SYNTHETIC_NOT_VERIFIABLE" ? "NOT VERIFIABLE" : r.isVerified}</span>
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] text-txt-muted">
                    {r.totalTrades} trades · WR {(r.winRate * 100).toFixed(0)}% · PF {r.profitFactor >= 999 ? "∞" : r.profitFactor.toFixed(2)} · net {r.netProfitLoss.toFixed(2)}
                  </div>
                </button>
              ))}
              {(data?.runs ?? []).length === 0 && <p className="text-xs text-txt-muted">No runs yet.</p>}
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
