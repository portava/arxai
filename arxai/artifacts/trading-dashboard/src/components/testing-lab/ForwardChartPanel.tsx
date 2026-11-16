// Testing Lab — forward (shadow) equity-in-R + drawdown chart panel (Task #763).
// DISPLAY-ONLY, admin-gated. Reads GET /api/forward-testing/chart-series, which
// derives the curve from realised R of closed shadow decisions. Forward results
// are OBSERVATIONS of the simulator stream, never live broker fills — the label
// and footer say so, and floating (unrealised) R is reported as unavailable
// rather than guessed.

import { useEffect, useState } from "react";
import { EquityCurveChart, DrawdownChart, type EquityPoint } from "@/components/analytics";
import type { ForwardChartSeries } from "@workspace/api-client-react";

export function ForwardChartPanel() {
  const [data, setData] = useState<ForwardChartSeries | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/forward-testing/chart-series", {
          headers: { "x-security-role": "ADMIN" },
        });
        if (!r.ok) throw new Error("failed");
        const j = (await r.json()) as ForwardChartSeries;
        if (alive) { setData(j); setError(false); }
      } catch {
        if (alive) setError(true);
      }
    }
    void load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (error) {
    return <p className="rounded border border-red-900/50 bg-red-950/20 p-6 text-center text-xs text-red-300">Could not load the forward chart series.</p>;
  }
  if (!data) {
    return <p className="rounded border border-slate-700 bg-slate-900/40 p-6 text-center text-xs text-slate-500">Loading chart…</p>;
  }

  const points = data.equity as EquityPoint[];
  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Equity (R) & drawdown</h3>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
          {data.label}
        </span>
      </div>
      <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-4">
        <span>Tracked <span className="font-mono text-slate-200">{data.summary.tracked}</span></span>
        <span>Realised <span className={`font-mono ${data.realizedR >= 0 ? "text-emerald-400" : "text-red-400"}`}>{data.realizedR >= 0 ? "+" : ""}{data.realizedR}R</span></span>
        <span>Max DD <span className="font-mono text-red-300">{data.maxDrawdownR}R</span></span>
        <span>Open <span className="font-mono text-slate-200">{data.openTrackingCount}</span></span>
      </div>
      {points.length === 0 ? (
        <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500">
          No closed forward-test outcomes yet.
        </p>
      ) : (
        <>
          <EquityCurveChart points={points} />
          <DrawdownChart points={points} maxDrawdown={data.maxDrawdownR} />
        </>
      )}
      <p className="text-[10px] text-slate-500">
        Observed shadow performance in R-multiples. Floating (unrealised) P/L is
        not marked-to-market here. No live orders are placed.
      </p>
    </div>
  );
}
