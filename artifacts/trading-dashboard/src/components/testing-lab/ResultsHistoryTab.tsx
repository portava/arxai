// Testing Lab — Strategy Results / History tab. Lists every backtest run and the
// current forward-test summary with an honest readiness verdict. Export is a
// client-side CSV of the real run rows — no fabricated metrics.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { BacktestRunRow, ForwardResults } from "./types";

function readiness(r: BacktestRunRow): { label: string; tone: "ready" | "warn" | "muted" } {
  if (r.isVerified === "VERIFIED" && r.totalTrades >= 30) return { label: "Ready for review", tone: "ready" };
  if (r.status === "INSUFFICIENT_DATA") return { label: "Insufficient data", tone: "warn" };
  return { label: "Needs more data", tone: "muted" };
}

function exportCsv(runs: BacktestRunRow[]) {
  const header = ["id", "strategy", "symbol", "timeframe", "trades", "winRatePct", "profitFactor", "netPnL", "status", "verified", "createdAt"];
  const lines = runs.map((r) => [
    r.id, r.strategyId, r.symbol, r.timeframe, r.totalTrades,
    (r.winRate * 100).toFixed(1), r.profitFactor, r.netProfitLoss, r.status, r.isVerified, r.createdAt,
  ].join(","));
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
  const { data: btData } = useQuery<{ runs: BacktestRunRow[] }>({
    queryKey: ["backtest-runs"],
    queryFn: async () => {
      const r = await fetch("/api/backtest-runs?limit=50");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const { data: fwd } = useQuery<ForwardResults>({
    queryKey: ["forward-testing-results"],
    queryFn: async () => {
      const r = await fetch("/api/forward-testing/results");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const allRuns = btData?.runs ?? [];
  const runs = strategyId ? allRuns.filter((r) => r.strategyId === strategyId) : allRuns;
  const fwdTracked = fwd?.shadowTradesTracked ?? 0;

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          All backtest runs and the current forward-test summary
          {strategyId ? ` for ${strategyId}` : ""}.
        </p>
        <Button size="sm" variant="outline" disabled={runs.length === 0} onClick={() => exportCsv(runs)}>
          Export CSV
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Backtest runs</CardTitle></CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-xs text-txt-muted">No backtest runs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-txt-secondary">
                  <tr>
                    <th className="py-1 pr-3">Strategy</th>
                    <th className="py-1 pr-3">Symbol</th>
                    <th className="py-1 pr-3">TF</th>
                    <th className="py-1 pr-3">Trades</th>
                    <th className="py-1 pr-3">WR</th>
                    <th className="py-1 pr-3">PF</th>
                    <th className="py-1 pr-3">Net</th>
                    <th className="py-1 pr-3">Readiness</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-foreground">
                  {runs.map((r) => {
                    const rd = readiness(r);
                    return (
                      <tr key={r.id} className="border-t border-border">
                        <td className="py-1 pr-3">{r.strategyId}</td>
                        <td className="py-1 pr-3">{r.symbol}</td>
                        <td className="py-1 pr-3">{r.timeframe}</td>
                        <td className="py-1 pr-3">{r.totalTrades}</td>
                        <td className="py-1 pr-3">{(r.winRate * 100).toFixed(0)}%</td>
                        <td className="py-1 pr-3">{r.profitFactor >= 999 ? "∞" : r.profitFactor.toFixed(2)}</td>
                        <td className={`py-1 pr-3 ${r.netProfitLoss >= 0 ? "text-success" : "text-danger"}`}>{r.netProfitLoss.toFixed(2)}</td>
                        <td className="py-1 pr-3">
                          <Badge className={
                            rd.tone === "ready" ? "bg-success/20 text-success"
                              : rd.tone === "warn" ? "bg-warning/20 text-warning"
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
        <CardHeader><CardTitle className="text-base">Forward test summary</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {fwdTracked === 0 ? (
            <p className="text-xs text-txt-muted">No forward-test results yet.</p>
          ) : (
            <div className="grid gap-1 sm:grid-cols-3">
              <span className="text-txt-secondary">Tracked: <span className="font-mono text-foreground">{fwdTracked}</span></span>
              <span className="text-txt-secondary">Win rate: <span className="font-mono text-foreground">{fwd?.winRate}%</span></span>
              <span className="text-txt-secondary">Avg R: <span className="font-mono text-foreground">{fwd?.avgR}</span></span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
