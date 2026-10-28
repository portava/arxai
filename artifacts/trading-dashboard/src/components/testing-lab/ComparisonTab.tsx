// Testing Lab — Comparison tab. Compares the backtest aggregate (historical)
// against the forward-test results (live simulator stream) for the selected
// strategy. Every number is derived from the real /api/backtest-runs and
// /api/forward-testing/results responses; missing data shows an honest empty
// state and is never fabricated.

import { useQuery, useQueries } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ComparisonOverlayChart, type OverlaySeries } from "./ComparisonOverlayChart";
import type { BacktestRunRow, ForwardResults } from "./types";
import { formatBacktestNumber } from "@workspace/domain/backtest";
import type { BacktestChartSeries, ForwardChartSeries } from "@workspace/api-client-react";

const OVERLAY_COLORS = ["#6366f1", "#f59e0b"];
const NO_TRACKED = "Unavailable — no tracked trades";


export function ComparisonTab({ strategyId }: { strategyId?: string }) {
  const { data: btData, isError: backtestError } = useQuery<{ runs: BacktestRunRow[] }>({
    queryKey: ["backtest-runs"],
    queryFn: async () => {
      const r = await fetch("/api/backtest-runs?limit=50");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const { data: fwd, isError: forwardError } = useQuery<ForwardResults>({
    queryKey: ["forward-testing-results"],
    queryFn: async () => {
      const r = await fetch("/api/forward-testing/results");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const allRuns = (btData?.runs ?? []).filter((r) => !strategyId || r.strategyId === strategyId);
  const [runA, setRunA] = useState<number | null>(null);
  const [runB, setRunB] = useState<number | null>(null);
  const [includeForward, setIncludeForward] = useState(true);
  useLayoutEffect(() => { setRunA(null); setRunB(null); }, [strategyId]);

  const selectedRunIds = [...new Set([runA, runB])].filter((x): x is number => x != null && allRuns.some((r) => r.id === x));
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
      const r = await fetch("/api/forward-testing/chart-series");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const overlaySeries: OverlaySeries[] = [];
  let unavailablePreciseCurve = false;
  seriesQueries.forEach((q, i) => {
    const s = q.data;
    if (!s || "blocked" in (s as object)) return;
    if (!(s.equity ?? []).every((point) => typeof point.grossPriceUnits === "number" && Number.isFinite(point.grossPriceUnits))) { unavailablePreciseCurve = true; return; }
    overlaySeries.push({
      key: `bt-${selectedRunIds[i]}`,
      label: `${s.strategyId ?? "backtest"} · ${s.symbol ?? ""}`.trim(),
      unit: "price units",
      color: OVERLAY_COLORS[i % OVERLAY_COLORS.length]!,
      points: (s.equity ?? []).map((p) => ({ tradeId: p.tradeId, value: p.grossPriceUnits! })),
    });
  });
  if (includeForward && fwdSeriesQuery.data) {
    const f = fwdSeriesQuery.data;
    overlaySeries.push({
      key: "forward",
      label: "Forward (shadow, all strategies)",
      unit: "R",
      color: "#10b981",
      points: (f.equity ?? []).map((p) => ({ tradeId: p.tradeId, value: p.equity })),
    });
  }

  const runs = allRuns;
  const btTrades = runs.reduce((a, r) => a + r.totalTrades, 0);
  const fwdTrades = fwd?.shadowTradesTracked ?? 0;
  const hasData = runs.length > 0 || fwdTrades > 0;
  const recommendation = "Comparison is unavailable: these backtests have no source-bound experiment or recorded costs and holdout. The forward summary covers all strategies, symbols and timeframes. Similar win rates do not establish out-of-sample performance.";
  // A read that is still in flight or failed is not a confirmed empty list:
  // runs falls back to [] and fwdTrades to 0 in those cases, so the empty
  // state is only shown once the backtest list was actually read and the
  // forward read has settled.
  const backtestLoaded = btData !== undefined;
  const forwardSettled = fwd !== undefined || forwardError;
  const forwardUnavailableLine = "Forward results are unavailable for this account.";

  if (!hasData) {
    if (!backtestLoaded && !backtestError) {
      return (
        <div className="pt-2">
          <p className="text-sm text-slate-400">Loading comparison data…</p>
        </div>
      );
    }
    if (backtestError) {
      return (
        <div className="pt-2 space-y-1">
          <p className="text-sm text-amber-300">
            Backtest runs could not be loaded, so comparison data cannot be checked right now.
          </p>
          {forwardError && <p className="text-xs text-slate-400">{forwardUnavailableLine}</p>}
        </div>
      );
    }
    if (!forwardSettled) {
      return (
        <div className="pt-2">
          <p className="text-sm text-slate-400">Loading comparison data…</p>
        </div>
      );
    }
    if (forwardError) {
      return (
        <div className="pt-2 space-y-1">
          <p className="text-sm text-slate-400">
            No backtest runs yet{strategyId ? ` for ${strategyId}` : ""}. Run a backtest to inspect diagnostic records.
          </p>
          <p className="text-xs text-slate-400">{forwardUnavailableLine}</p>
        </div>
      );
    }
    return (
      <div className="pt-2">
        <p className="text-sm text-slate-400">
          No comparison data yet{strategyId ? ` for ${strategyId}` : ""}. Run a backtest and a
          forward test to inspect diagnostic records. Matched out-of-sample comparison requires verified experiment evidence.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Diagnostic backtests and unfiltered shadow results
          {strategyId ? ` — ${strategyId}` : ""}.
        </p>
        <Badge>Comparison unavailable</Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Backtest diagnostics</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!backtestLoaded ? <p className="text-xs text-slate-400">{backtestError ? "Backtest runs could not be loaded." : "Backtest runs have not loaded."}</p> : <>
            <Row label="Runs" value={String(runs.length)} />
            <Row label="Sample (trades)" value={String(btTrades)} />
            <Row label="Cross-run performance" value="Not aggregated across experiments" muted />
            <Row label="Verification" value="Unavailable" muted />
            <Row label="Drawdown" value="open a run for detail" muted />
            </>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Forward test · all strategies</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!fwd ? <p className="text-xs text-slate-400">{forwardError ? forwardUnavailableLine : "Forward results have not loaded."}</p> : <>
            <Row label="Decisions" value={String(fwd?.totalShadowDecisions ?? 0)} />
            <Row label="Sample (trades)" value={String(fwdTrades)} />
            {/* With zero tracked (win/loss) trades the server still returns 0s
                and an arbitrary symbol ranking; none of it was measured. */}
            <Row label="Win rate" value={fwdTrades > 0 ? `${formatBacktestNumber(fwd.winRate)}%` : NO_TRACKED} muted={fwdTrades === 0} />
            <Row label="Avg R" value={fwdTrades > 0 ? formatBacktestNumber(fwd.avgR) : NO_TRACKED} muted={fwdTrades === 0} />
            <Row label="Max DD (R)" value={fwdTrades > 0 ? formatBacktestNumber(fwd.maxDrawdownR) : NO_TRACKED} muted={fwdTrades === 0} />
            <Row label="Best / worst symbol" value={fwdTrades > 0 ? `${fwd.bestSymbol ?? "—"} / ${fwd.worstSymbol ?? "—"}` : NO_TRACKED} muted={fwdTrades === 0} />
            </>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Equity overlay</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1 text-slate-400">
              Curve A
              <select className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                value={runA ?? ""} onChange={(e) => setRunA(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {allRuns.map((r) => (
                  <option key={r.id} value={r.id}>{r.strategyId} · {r.symbol} · {r.timeframe}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-slate-400">
              Curve B
              <select className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                value={runB ?? ""} onChange={(e) => setRunB(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— none —</option>
                {allRuns.map((r) => (
                  <option key={r.id} value={r.id}>{r.strategyId} · {r.symbol} · {r.timeframe}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-slate-400">
              <input type="checkbox" checked={includeForward} onChange={(e) => setIncludeForward(e.target.checked)} />
              Forward (shadow, all strategies, R)
            </label>
          </div>
          {unavailablePreciseCurve && <p className="text-xs text-amber-300">A selected curve lacks precise price-unit values. Reload it from the updated service.</p>}
          {includeForward && fwdSeriesQuery.isError && <p className="text-xs text-slate-400">Forward curve is unavailable for this account.</p>}
          <ComparisonOverlayChart series={overlaySeries} />
          <p className="text-[10px] text-slate-500">
            Backtest curves use gross price units; forward curves use R and are shown on a separate scale.
            Different markets, sources or experiment periods are not comparable just because their curves look similar.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Evidence required</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-slate-300">{recommendation}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={muted ? "text-xs text-slate-500" : "font-mono text-slate-100"}>{value}</span>
    </div>
  );
}
