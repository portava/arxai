// Testing Lab — Strategy Results / History tab. Lists every backtest run and the
// unfiltered forward-test summary with an honest readiness verdict. Export is a
// client-side CSV of the real run rows — no fabricated metrics.

import { useQuery } from "@tanstack/react-query";
import { formatBacktestPriceUnits, formatBacktestNumber, formatBacktestPercent, formatBacktestProfitFactor } from "@workspace/domain/backtest";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BACKTEST_NOT_MEASURED, backtestMetricsUnmeasured } from "@/components/backtesting/backtestRunMeasurement";
import type { BacktestRunRow, ForwardResults } from "./types";

function readiness(r: BacktestRunRow): { label: string; tone: "ready" | "warn" | "muted" } {
  if (r.status === "INSUFFICIENT_DATA") return { label: "Insufficient data", tone: "warn" };
  return { label: "Diagnostic only", tone: "muted" };
}

function exportCsv(runs: BacktestRunRow[]) {
  const header = ["id", "strategy", "symbol", "timeframe", "trades", "winRate", "profitFactor", "grossPriceUnits", "status", "verification", "createdAt"];
  const lines = runs.map((r) => [
    r.id, r.strategyId, r.symbol, r.timeframe, r.totalTrades,
    ...(backtestMetricsUnmeasured(r)
      ? [BACKTEST_NOT_MEASURED, BACKTEST_NOT_MEASURED, BACKTEST_NOT_MEASURED]
      : [formatBacktestPercent(r.winRate), formatBacktestProfitFactor(r.profitFactor), formatBacktestPriceUnits(r.netProfitLoss)]),
    r.status, "UNVERIFIED", r.createdAt,
  ].map((value) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(","));
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "testing-lab-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function ResultsHistoryTab({ strategyId }: { strategyId?: string }) {
  const { data: btData, isLoading: btLoading, isError: btError } = useQuery<{ runs: BacktestRunRow[] }>({
    queryKey: ["backtest-runs"],
    queryFn: async () => {
      const r = await fetch("/api/backtest-runs?limit=50");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const { data: fwd, isLoading: fwdLoading, isError: fwdError } = useQuery<ForwardResults>({
    queryKey: ["forward-testing-results"],
    queryFn: async () => {
      const r = await fetch("/api/forward-testing/results");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const backtestUnavailable = btError || !Array.isArray(btData?.runs);
  const allRuns = backtestUnavailable ? [] : btData!.runs;
  const runs = strategyId ? allRuns.filter((r) => r.strategyId === strategyId) : allRuns;
  const fwdTracked = fwd?.shadowTradesTracked;
  const forwardUnavailable = fwdError || typeof fwdTracked !== "number" || !Number.isInteger(fwdTracked) || fwdTracked < 0;

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Diagnostic backtest runs and the unfiltered forward-test summary
          {strategyId ? ` for ${strategyId}` : ""}.
        </p>
        <Button size="sm" variant="outline" disabled={runs.length === 0} onClick={() => exportCsv(runs)}>
          Export CSV
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Backtest runs</CardTitle></CardHeader>
        <CardContent>
          {btLoading ? <p className="text-xs text-slate-500">Loading backtest history…</p>
          : backtestUnavailable ? <p className="text-xs text-amber-300">Backtest history unavailable.</p>
          : runs.length === 0 ? (
            <p className="text-xs text-slate-500">No backtest runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="py-1 pr-3">Strategy</th>
                    <th className="py-1 pr-3">Symbol</th>
                    <th className="py-1 pr-3">TF</th>
                    <th className="py-1 pr-3">Trades</th>
                    <th className="py-1 pr-3">WR</th>
                    <th className="py-1 pr-3">PF</th>
                    <th className="py-1 pr-3">Gross (price units)</th>
                    <th className="py-1 pr-3">Readiness</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-slate-200">
                  {runs.map((r) => {
                    const rd = readiness(r);
                    // Zero completed trades → stored metric zeros are not observations.
                    const unmeasured = backtestMetricsUnmeasured(r);
                    return (
                      <tr key={r.id} className="border-t border-slate-800">
                        <td className="py-1 pr-3">{r.strategyId}</td>
                        <td className="py-1 pr-3">{r.symbol}</td>
                        <td className="py-1 pr-3">{r.timeframe}</td>
                        <td className="py-1 pr-3">{formatBacktestNumber(r.totalTrades)}</td>
                        <td className={`py-1 pr-3 ${unmeasured ? "text-slate-400" : ""}`}>{unmeasured ? BACKTEST_NOT_MEASURED : formatBacktestPercent(r.winRate)}</td>
                        <td className={`py-1 pr-3 ${unmeasured ? "text-slate-400" : ""}`}>{unmeasured ? BACKTEST_NOT_MEASURED : formatBacktestProfitFactor(r.profitFactor)}</td>
                        <td className={`py-1 pr-3 ${unmeasured || typeof r.netProfitLoss !== "number" || !Number.isFinite(r.netProfitLoss) ? "text-slate-400" : r.netProfitLoss >= 0 ? "text-emerald-400" : "text-red-400"}`}>{unmeasured ? BACKTEST_NOT_MEASURED : formatBacktestPriceUnits(r.netProfitLoss)}</td>
                        <td className="py-1 pr-3">
                          <Badge className={
                            rd.tone === "ready" ? "bg-emerald-500/20 text-emerald-300"
                              : rd.tone === "warn" ? "bg-amber-500/20 text-amber-300"
                                : ""
                          }>{rd.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Forward test summary · all strategies</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {fwdLoading ? <p className="text-xs text-slate-500">Loading forward-test history…</p>
          : forwardUnavailable ? <p className="text-xs text-amber-300">Forward-test history unavailable.</p>
          : fwdTracked === 0 ? (
            <p className="text-xs text-slate-500">No forward-test results yet.</p>
          ) : (
            <div className="grid gap-1 sm:grid-cols-3">
              <span className="text-slate-400">Tracked: <span className="font-mono text-slate-100">{fwdTracked}</span></span>
              <span className="text-slate-400">Win rate: <span className="font-mono text-slate-100">{typeof fwd?.winRate === "number" && Number.isFinite(fwd.winRate) ? `${formatBacktestNumber(fwd.winRate)}%` : "Unavailable"}</span></span>
              <span className="text-slate-400">Avg R: <span className="font-mono text-slate-100">{formatBacktestNumber(fwd?.avgR)}</span></span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
