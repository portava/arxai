// (O) Portfolio risk card — shows the latest snapshot's overall level,
// open positions, total risk %, unrealized P&L, correlation concentration,
// and reasons/warnings/blockers. Refresh button triggers a new snapshot.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type Level = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

interface Snapshot {
  id: number;
  accountBalance: number; accountEquity: number;
  openPositionsCount: number;
  totalOpenLotSize: number;
  totalUnrealizedPnl: number;
  totalRiskAmount: number; totalRiskPercent: number;
  correlatedExposureScore: number;
  portfolioRiskLevel: Level;
  reasons: string[]; warnings: string[]; blockers: string[];
  aiSummary?: string;
  createdAt: string;
}

const LEVEL_STYLES: Record<Level, string> = {
  LOW:      "bg-success/15 text-white",
  MODERATE: "bg-warning/15 text-white",
  HIGH:     "bg-warning/15 text-white",
  CRITICAL: "bg-danger/15 text-white animate-pulse",
};

export function PortfolioRiskCard() {
  const qc = useQueryClient();
  const latest = useQuery<Snapshot>({
    queryKey: ["portfolio-risk-latest"],
    queryFn: async () => {
      const r = await fetch("/api/portfolio-risk/latest");
      if (r.status === 404) throw new Error("no-snapshot");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    retry: false,
    refetchInterval: 30_000,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/portfolio-risk/snapshot", { method: "POST" });
      if (!r.ok) throw new Error("failed");
      return r.json() as Promise<Snapshot>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio-risk-latest"] }),
  });

  const s = latest.data;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Portfolio Risk</h3>
          <p className="text-xs text-txt-muted">{s ? new Date(s.createdAt).toLocaleString() : "no snapshot yet"}</p>
        </div>
        <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary disabled:opacity-50">
          {refresh.isPending ? "Computing…" : (s ? "Refresh" : "Generate snapshot")}
        </button>
      </header>

      {!s && !latest.isLoading && (
        <p className="text-sm text-txt-secondary">No portfolio snapshot yet. Click "Generate snapshot" to compute.</p>
      )}

      {s && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${LEVEL_STYLES[s.portfolioRiskLevel]}`}>
              {s.portfolioRiskLevel}
            </span>
            <span className="text-sm text-txt-secondary">{s.openPositionsCount} open</span>
            <span className="text-sm text-txt-secondary">Total risk: <span className="font-semibold text-foreground">{s.totalRiskPercent.toFixed(2)}%</span></span>
            <span className={`text-sm ${s.totalUnrealizedPnl >= 0 ? "text-success" : "text-danger"}`}>
              P&L {s.totalUnrealizedPnl >= 0 ? "+" : ""}{s.totalUnrealizedPnl.toFixed(2)}
            </span>
            <span className="text-sm text-txt-secondary">Corr score: <span className="font-semibold text-foreground">{s.correlatedExposureScore}/100</span></span>
          </div>

          {s.blockers.length > 0 && (
            <div className="rounded-md border border-danger/40 bg-danger/40 p-3 text-xs text-danger">
              <div className="mb-1 font-semibold uppercase tracking-wide">⛔ Blocked</div>
              <ul className="list-inside list-disc space-y-0.5">{s.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
          {s.warnings.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/40 p-3 text-xs text-warning">
              <div className="mb-1 font-semibold uppercase tracking-wide">⚠ Warnings</div>
              <ul className="list-inside list-disc space-y-0.5">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {s.aiSummary && (
            <p className="rounded-md border border-border bg-background/40 p-3 text-xs text-txt-secondary">{s.aiSummary}</p>
          )}
        </>
      )}
    </div>
  );
}
