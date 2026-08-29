// Testing Lab — Comparison tab. Compares the backtest aggregate (historical)
// against the forward-test results (live simulator stream) for the selected
// strategy. Every number is derived from the real /api/backtest-runs and
// /api/forward-testing/results responses; missing data shows an honest empty
// state and is never fabricated.

import { useQuery, useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ComparisonOverlayChart, type OverlaySeries } from "./ComparisonOverlayChart";
import type { BacktestRunRow, ForwardResults } from "./types";
import type { BacktestChartSeries, ForwardChartSeries } from "@workspace/api-client-react";

const OVERLAY_COLORS = ["#6366f1", "#f59e0b"];

const DRIFT_THRESHOLD_PCTPTS = 15;
const MIN_SAMPLE = 10;

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function ComparisonTab({ strategyId }: { strategyId?: string }) {
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
  const [runA, setRunA] = useState<number | null>(null);
  const [runB, setRunB] = useState<number | null>(null);
  const [includeForward, setIncludeForward] = useState(true);

  const selectedRunIds = [runA, runB].filter((x): x is number => x != null);
  const seriesQueries = useQueries({
    queries: selectedRunIds.map((id) => ({
      queryKey: ["backtest-chart-series", id],
      queryFn: async (): Promise<BacktestChartSeries> => {
        const r = await fetch(`/api/backtest-runs/${id}/chart-series`);
        if (!r.ok) throw new Error("failed");
        return r.json();
      },
    })),
  });
  const fwdSeriesQuery = useQuery<ForwardChartSeries>({
    queryKey: ["forward-chart-series"],
    enabled: includeForward,
    queryFn: async () => {
      const r = await fetch("/api/forward-testing/chart-series", { headers: { "x-security-role": "ADMIN" } });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const overlaySeries: OverlaySeries[] = [];
  seriesQueries.forEach((q, i) => {
    const s = q.data;
    if (!s || "blocked" in (s as object)) return;
    overlaySeries.push({
      key: `bt-${selectedRunIds[i]}`,
      label: `${s.strategyId ?? "backtest"} · ${s.symbol ?? ""}`.trim(),
      unit: "$",
      color: OVERLAY_COLORS[i % OVERLAY_COLORS.length]!,
      points: (s.equity ?? []).map((p) => ({ tradeId: p.tradeId, value: p.equity - s.initialBalance })),
    });
  });
  if (includeForward && fwdSeriesQuery.data) {
    const f = fwdSeriesQuery.data;
    overlaySeries.push({
      key: "forward",
      label: "Forward (shadow)",
      unit: "R",
      color: "#10b981",
      points: (f.equity ?? []).map((p) => ({ tradeId: p.tradeId, value: p.equity })),
    });
  }

  const runs = allRuns.filter((r) => !strategyId || r.strategyId === strategyId);
  const btTrades = runs.reduce((a, r) => a + r.totalTrades, 0);
  const btWinRatePct = btTrades > 0
    ? (runs.reduce((a, r) => a + r.winRate * r.totalTrades, 0) / btTrades) * 100
    : null;
  const finitePf = runs.map((r) => r.profitFactor).filter((p) => Number.isFinite(p) && p < 999);
  const btPf = avg(finitePf);

  const fwdTrades = fwd?.shadowTradesTracked ?? 0;
  const fwdWinRatePct = fwd && fwdTrades > 0 ? fwd.winRate : null;

  const hasData = runs.length > 0 || fwdTrades > 0;

  let driftLabel = "Not enough data";
  let driftTone: "warn" | "ok" | "muted" = "muted";
  let drift: number | null = null;
  if (btWinRatePct != null && fwdWinRatePct != null && btTrades >= MIN_SAMPLE && fwdTrades >= MIN_SAMPLE) {
    drift = Math.abs(btWinRatePct - fwdWinRatePct);
    if (drift > DRIFT_THRESHOLD_PCTPTS) {
      driftLabel = `Drift ${drift.toFixed(0)} pts`;
      driftTone = "warn";
    } else {
      driftLabel = `Aligned (${drift.toFixed(0)} pts)`;
      driftTone = "ok";
    }
  }

  let recommendation: string;
  if (!hasData) {
    recommendation = "No comparison data yet.";
  } else if (drift == null) {
    recommendation = "Run both a backtest and a forward test for this strategy (at least " +
      `${MIN_SAMPLE} trades each) before comparing — there isn't enough sample to judge drift yet.`;
  } else if (driftTone === "warn") {
    recommendation = "Backtest and forward win rates diverge meaningfully. The strategy may be " +
      "overfit to historical candles — keep it on the demo/shadow path and do not trust it live yet.";
  } else {
    recommendation = "Backtest and forward results are consistent. The edge is holding up out of " +
      "sample, but continue forward testing before increasing exposure.";
  }

  if (!hasData) {
    return (
      <div className="pt-2">
        <p className="text-sm text-txt-secondary">
          No comparison data yet{strategyId ? ` for ${strategyId}` : ""}. Run a backtest and a
          forward test, then return here to compare historical vs live behaviour.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Backtest (historical) vs forward test (live simulator)
          {strategyId ? ` — ${strategyId}` : ""}.
        </p>
        <Badge className={
          driftTone === "warn" ? "bg-warning/20 text-warning"
            : driftTone === "ok" ? "bg-success/20 text-success"
              : ""
        }>{driftLabel}</Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Backtest (historical)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Runs" value={String(runs.length)} />
            <Row label="Sample (trades)" value={String(btTrades)} />
            <Row label="Win rate" value={btWinRatePct != null ? `${btWinRatePct.toFixed(0)}%` : "—"} />
            <Row label="Profit factor" value={btPf != null ? btPf.toFixed(2) : "—"} />
            <Row label="Drawdown" value="open a run for detail" muted />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Forward test (live sim)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Decisions" value={String(fwd?.totalShadowDecisions ?? 0)} />
            <Row label="Sample (trades)" value={String(fwdTrades)} />
            <Row label="Win rate" value={fwdWinRatePct != null ? `${fwdWinRatePct}%` : "—"} />
            <Row label="Avg R" value={fwd ? String(fwd.avgR) : "—"} />
            <Row label="Max DD (R)" value={fwd ? String(fwd.maxDrawdownR) : "—"} />
            <Row label="Best / worst symbol" value={`${fwd?.bestSymbol ?? "—"} / ${fwd?.worstSymbol ?? "—"}`} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Equity overlay</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1 text-txt-secondary">
              Curve A
              <select className="rounded border border-border bg-background px-2 py-1 text-foreground"
                value={runA ?? ""} onChange={(e) => setRunA(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {allRuns.map((r) => (
                  <option key={r.id} value={r.id}>{r.strategyId} · {r.symbol} · {r.timeframe}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-txt-secondary">
              Curve B
              <select className="rounded border border-border bg-background px-2 py-1 text-foreground"
                value={runB ?? ""} onChange={(e) => setRunB(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {allRuns.map((r) => (
                  <option key={r.id} value={r.id}>{r.strategyId} · {r.symbol} · {r.timeframe}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-txt-secondary">
              <input type="checkbox" checked={includeForward} onChange={(e) => setIncludeForward(e.target.checked)} />
              Forward (shadow, R)
            </label>
          </div>
          <ComparisonOverlayChart series={overlaySeries} />
          <p className="text-[10px] text-txt-muted">
            Backtest curves are account-currency growth; the forward curve is
            cumulative R. Each line is labeled with its unit — they are not merged
            into one magnitude.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{nameHint()} recommendation</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-txt-secondary">{recommendation}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function nameHint(): string {
  return "Eleanor";
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-txt-secondary">{label}</span>
      <span className={muted ? "text-xs text-txt-muted" : "font-mono text-foreground"}>{value}</span>
    </div>
  );
}
