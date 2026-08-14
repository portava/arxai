// (M) Build M — primary multi-timeframe display. Shows the alignment label,
// score, per-TF trend snapshots, and the AI summary. Includes a "Refresh"
// button that triggers a fresh /multi-timeframe/generate. SAFETY: never
// presents a buy/sell signal — only "preferred bias" with the disclaimer
// surfaced via the AI summary string.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TimeframeConflictWarning } from "./TimeframeConflictWarning";
import { HigherTimeframeBiasCard } from "./HigherTimeframeBiasCard";

type Trend = "UP" | "DOWN" | "SIDEWAYS";
type Snap = { trend: Trend; strength: number; slope: number; fastSma: number; slowSma: number; candlesUsed: number };

export interface MultiTimeframeReport {
  id: number;
  symbol: string;
  lowerTimeframe: string; middleTimeframe: string; higherTimeframe: string;
  lowerTrend: Snap; middleTrend: Snap; higherTrend: Snap;
  alignmentScore: number;
  alignmentLabel:
    | "STRONG_BULLISH_ALIGNMENT" | "STRONG_BEARISH_ALIGNMENT" | "MIXED_ALIGNMENT"
    | "LOWER_TIMEFRAME_CONFLICT" | "HIGHER_TIMEFRAME_WARNING" | "NO_CLEAR_BIAS";
  conflictWarning: string | null;
  bestBias: "BUY" | "SELL" | "NEUTRAL";
  aiSummary: string;
  createdAt: string;
}

const LABEL_STYLES: Record<MultiTimeframeReport["alignmentLabel"], string> = {
  STRONG_BULLISH_ALIGNMENT: "bg-green-700 text-white",
  STRONG_BEARISH_ALIGNMENT: "bg-red-700 text-white",
  MIXED_ALIGNMENT: "bg-amber-700 text-white",
  LOWER_TIMEFRAME_CONFLICT: "bg-amber-800 text-amber-100",
  HIGHER_TIMEFRAME_WARNING: "bg-orange-800 text-orange-100",
  NO_CLEAR_BIAS: "bg-slate-700 text-slate-200",
};
const TREND_STYLES: Record<Trend, string> = {
  UP: "text-green-400", DOWN: "text-red-400", SIDEWAYS: "text-slate-400",
};

export function MultiTimeframeAlignmentCard({ symbol }: { symbol: string | null }) {
  const qc = useQueryClient();
  const enabled = !!symbol;
  const latest = useQuery<MultiTimeframeReport>({
    queryKey: ["mtf-latest", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/multi-timeframe/latest?symbol=${encodeURIComponent(symbol!)}`);
      if (r.status === 404) throw new Error("no-report");
      if (!r.ok) throw new Error("Failed to load report");
      return r.json();
    },
    enabled,
    retry: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/multi-timeframe/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!r.ok) throw new Error("Failed to generate report");
      return r.json() as Promise<MultiTimeframeReport>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mtf-latest", symbol] }),
  });

  if (!symbol) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-400">
        Set a symbol on the plan to enable multi-timeframe analysis.
      </div>
    );
  }

  const r = latest.data;

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Multi-Timeframe Alignment</h3>
          <p className="text-xs text-slate-500">
            {symbol} · {r ? new Date(r.createdAt).toLocaleString() : "no report yet"}
          </p>
        </div>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generate.isPending ? "Scanning…" : (r ? "Refresh scan" : "Run scan")}
        </button>
      </header>

      {!r && !latest.isLoading && (
        <p className="text-sm text-slate-400">No report for this symbol yet. Click "Run scan" to generate one.</p>
      )}

      {r && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${LABEL_STYLES[r.alignmentLabel]}`}>
              {r.alignmentLabel.replace(/_/g, " ")}
            </span>
            <span className="text-sm text-slate-300">
              Alignment <span className="font-semibold text-slate-100">{Math.round(r.alignmentScore)}/100</span>
            </span>
            <span className="text-sm text-slate-300">
              Best bias <span className="font-semibold text-slate-100">{r.bestBias}</span>
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[
              { label: r.lowerTimeframe,  s: r.lowerTrend,  tag: "Lower" },
              { label: r.middleTimeframe, s: r.middleTrend, tag: "Middle" },
              { label: r.higherTimeframe, s: r.higherTrend, tag: "Higher" },
            ].map((tf) => (
              <div key={tf.tag} className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{tf.tag} · {tf.label}</div>
                <div className={`text-sm font-semibold ${TREND_STYLES[tf.s.trend]}`}>{tf.s.trend}</div>
                <div className="text-xs text-slate-400">strength {tf.s.strength}</div>
              </div>
            ))}
          </div>

          <TimeframeConflictWarning warning={r.conflictWarning} label={r.alignmentLabel} />
          <HigherTimeframeBiasCard
            higherTimeframe={r.higherTimeframe}
            higherTrend={r.higherTrend}
            bestBias={r.bestBias}
          />

          <p className="rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
            {r.aiSummary}
          </p>
        </>
      )}
    </div>
  );
}
