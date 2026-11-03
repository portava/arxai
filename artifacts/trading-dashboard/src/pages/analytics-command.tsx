import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EquityCurveChart, DrawdownChart, StrategyAnalyticsTable,
  SessionHeatmap, EmotionalTrendGraph, RiskExposureGraph, ConsistencyTrendCard,
} from "@/components/analytics";
import type { AnalyticsFigures, AnalyticsSnapshot, AnalyticsCurrent, StrategyRow, EquityPoint } from "@/components/analytics";
import type { EdgeSliceHighlight } from "@/components/analytics/types";

interface DrawdownResponse { equityCurve: EquityPoint[]; maxDrawdown: number }
interface SessionBucket { trades: number; pnl: number; wins: number; sizedTrades?: number }
type SessionData = Record<"ASIA"|"LONDON"|"NEWYORK", SessionBucket>;
interface EmotionalResponse { trend: Array<{ idx:number; isCalm:number; followedPlan:number; emotion:string }>; totalDebriefs: number }

/** GET /analytics/snapshot: the last saved snapshot and the figures computed now. */
interface SnapshotResponse {
  snapshot: AnalyticsSnapshot | null;
  /** Absent on older servers; null with currentError when the live computation failed. */
  current?: AnalyticsCurrent | null;
  currentError?: string | null;
}

function when(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

export default function AnalyticsCommandCenter() {
  const qc = useQueryClient();
  const snap = useQuery<SnapshotResponse>({
    queryKey: ["analytics-snapshot"],
    queryFn: async () => (await fetch("/api/analytics/snapshot")).json(),
  });
  const strat = useQuery<{ strategies: StrategyRow[] }>({
    queryKey: ["analytics-strategy"],
    queryFn: async () => (await fetch("/api/analytics/strategy")).json(),
  });
  const sess = useQuery<{ session: SessionData; sessionBasis?: string }>({
    queryKey: ["analytics-session"],
    queryFn: async () => (await fetch("/api/analytics/session")).json(),
  });
  const emo = useQuery<EmotionalResponse>({
    queryKey: ["analytics-emotional"],
    queryFn: async () => (await fetch("/api/analytics/emotional")).json(),
  });
  const dd = useQuery<DrawdownResponse>({
    queryKey: ["analytics-drawdown"],
    queryFn: async () => (await fetch("/api/analytics/drawdown")).json(),
  });

  const generate = useMutation({
    mutationFn: async () => (await fetch("/api/analytics/snapshot", { method: "POST" })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics-snapshot"] }),
  });

  // Auto-generate first snapshot if none exists.
  useEffect(() => {
    if (snap.isSuccess && snap.data?.snapshot == null && !generate.isPending) generate.mutate();
  }, [snap.isSuccess, snap.data?.snapshot, generate]);

  // The tiles use the figures computed now from every paper order when the
  // server sent them, so they agree with the tables below (always computed
  // live). Otherwise they fall back to the last saved snapshot, which can miss
  // trades closed after it was computed, and the page says so.
  const saved = snap.data?.snapshot ?? null;
  const live = snap.data?.current ?? null;
  const s = live ?? (saved ? downgradeSaved(saved) : null);
  const savedAt = when(saved?.createdAt);
  const asOfLine = live
    ? `Computed from all your paper orders at ${when(live.asOf) ?? "an unknown time"}.${savedAt ? ` Last saved snapshot: ${savedAt}.` : ""}`
    : saved
      ? `Saved snapshot computed ${savedAt ?? "at an unknown time"} — trades closed after it are not included${snap.data?.currentError ? ` (${snap.data.currentError})` : ""}. Recompute to refresh.`
      : null;

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Analytics Command Center</h1>
          <p className="text-xs text-slate-400">
            Institutional-style process analytics. Past performance does not predict future results.
          </p>
        </div>
        <button onClick={() => generate.mutate()} disabled={generate.isPending}
          className="rounded bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40">
          {generate.isPending ? "Computing…" : "Recompute snapshot"}
        </button>
      </header>

      {!s ? (
        <p className="rounded border border-dashed border-slate-700 p-6 text-center text-xs text-slate-500">
          Computing your first analytics snapshot…
        </p>
      ) : (
        <>
          <p className={`text-[11px] ${live ? "text-slate-400" : "text-amber-300"}`} data-testid="analytics-asof">{asOfLine}</p>

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <Stat id="trades"        label="Trades"        v={s.totalTrades.toString()} />
            {/* null = not measured: "—", no colour, and the reason below. */}
            <Stat id="net-pnl"       label="Net P&L"       v={s.netProfitLoss == null ? "—" : `$${s.netProfitLoss.toFixed(0)}`} tone={s.netProfitLoss == null ? undefined : s.netProfitLoss >= 0 ? "emerald" : "red"} />
            <Stat id="win-rate"      label="Win rate"      v={s.winRate == null ? "—" : `${(s.winRate*100).toFixed(1)}%`} />
            <Stat id="avg-rr"        label="Avg RR"        v={s.averageRr == null ? "—" : `${s.averageRr.toFixed(2)}R`} />
            <Stat id="expectancy"    label="Expectancy"    v={s.expectancy == null ? "—" : `$${s.expectancy.toFixed(2)}`} tone={s.expectancy == null ? undefined : s.expectancy >= 0 ? "emerald" : "red"} />
            <Stat id="profit-factor" label="Profit factor" v={s.profitFactor == null ? "—" : s.profitFactor.toFixed(2)} />
            <Stat id="max-dd"        label="Max DD"        v={s.maxDrawdown == null ? "—" : `$${s.maxDrawdown.toFixed(0)}`} tone={s.maxDrawdown != null && s.maxDrawdown > 0 ? "red" : undefined} />
          </section>
          {notMeasuredLine(s) ? (
            <p className="text-[11px] text-slate-400" data-testid="analytics-unmeasured">{notMeasuredLine(s)}</p>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <EquityCurveChart points={dd.data?.equityCurve ?? []} />
            <DrawdownChart    points={dd.data?.equityCurve ?? []} maxDrawdown={dd.data?.maxDrawdown ?? 0} />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <RiskExposureGraph snapshot={s} />
            <ConsistencyTrendCard snapshot={s} />
            <SessionHeatmap data={(sess.data?.session ?? {}) as any} basis={sess.data?.sessionBasis} />
          </div>

          <EmotionalTrendGraph trend={emo.data?.trend ?? []} />

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Results by symbol</h3>
            <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            {/* These group by SYMBOL and by Edge Discovery slice: paper orders
                carry no strategy, and no edge report records a market condition. */}
            <Highlight id="best-symbol"  label="Best symbol (net P&L)"  v={live ? live.strongestSymbol ?? null : s.strongestStrategy} tone="emerald" empty="No symbol is net profitable"
              sub={live?.highlightBasis?.symbols ?? "Highest net P&L among symbols when the snapshot was saved."} />
            <Highlight id="worst-symbol" label="Worst symbol (net P&L)" v={live ? live.weakestSymbol ?? null : s.weakestStrategy} tone="red" empty="No symbol is net losing"
              sub={live?.highlightBasis?.symbols ?? "Lowest net P&L among symbols when the snapshot was saved."} />
            <Highlight id="strongest-edge" label="Strongest edge slice" v={live ? edgeSliceText(live.strongestEdgeSlice) : s.strongestMarketCondition} tone="emerald" empty="No slice is rated a strong or developing edge"
              sub={live?.highlightBasis?.edgeSlices ?? "The edge report with the highest confidence score when the snapshot was saved — not your results in a market condition."} />
            <Highlight id="weakest-edge" label="Weakest edge slice" v={live ? edgeSliceText(live.weakestEdgeSlice) : s.weakestMarketCondition} tone="red" empty="No slice is rated a weak or no edge"
              sub={live?.highlightBasis?.edgeSlices ?? "The edge report with the lowest confidence score when the snapshot was saved — not your results in a market condition."} />
          </section>

          <p className="text-[10px] italic text-slate-500">
            Analytics summarize historical behavior and outcomes. Past performance does not predict future results.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ id, label, v, tone }: { id?: string; label: string; v: string; tone?: "emerald"|"red" }) {
  const t = tone === "emerald" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-slate-100";
  return (
    <div className="rounded border border-slate-700 bg-slate-900/50 p-2 text-center" data-testid={id ? `analytics-stat-${id}` : undefined}>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-base font-bold ${t}`}>{v}</div>
    </div>
  );
}
const FIGURE_LABELS: Record<string, string> = {
  netProfitLoss: "Net P&L", winRate: "Win rate", averageRr: "Avg RR", expectancy: "Expectancy",
  profitFactor: "Profit factor", maxDrawdown: "Max DD",
};
/** "Not measured: Win rate (No closed paper trades yet); ..." for the tiles above. */
function notMeasuredLine(f: AnalyticsFigures): string | null {
  const parts = Object.entries(FIGURE_LABELS)
    .filter(([k]) => f[k as keyof AnalyticsFigures] == null)
    .map(([k, label]) => {
      const why = f.unmeasured?.[k];
      return why ? `${label} (${why.endsWith(".") ? why.slice(0, -1) : why})` : label;
    });
  return parts.length ? `Not measured: ${parts.join("; ")}.` : null;
}

/**
 * A saved snapshot's columns are NOT NULL, so "not measured" was stored as 0
 * (and a profit factor with no losing trade as 999). Downgrade what the row
 * itself shows was not measured; its behaviour scores cannot be told apart.
 */
function downgradeSaved(r: AnalyticsSnapshot): AnalyticsFigures {
  const noTrades = r.totalTrades === 0;
  const why = "No closed paper trades when this snapshot was saved.";
  return {
    ...r,
    netProfitLoss: noTrades ? null : r.netProfitLoss,
    winRate: noTrades ? null : r.winRate,
    averageRr: noTrades ? null : r.averageRr,
    expectancy: noTrades ? null : r.expectancy,
    profitFactor: noTrades || r.profitFactor === 999 ? null : r.profitFactor,
    maxDrawdown: noTrades ? null : r.maxDrawdown,
    unmeasured: noTrades
      ? Object.fromEntries(Object.keys(FIGURE_LABELS).map((k) => [k, why]))
      : r.profitFactor === 999 ? { profitFactor: "No losing trade, so gross win ÷ gross loss is undefined." } : {},
  };
}

function edgeSliceText(e: EdgeSliceHighlight | null | undefined): string | null {
  return e ? `${e.label} — ${e.statusWords}, confidence ${e.confidenceScore}/100 (${e.sampleSize} trades)` : null;
}
function Highlight({ id, label, v, tone, sub, empty }: { id: string; label: string; v: string | null; tone: "emerald"|"red"; sub?: string; empty: string }) {
  const t = tone === "emerald" ? "border-emerald-700 bg-emerald-950/30 text-emerald-100" : "border-red-700 bg-red-950/30 text-red-100";
  return (
    <div className={`rounded border p-3 ${t}`} data-testid={`analytics-highlight-${id}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-base font-semibold">{v ?? empty}</div>
      {sub ? <div className="mt-1 text-[10px] opacity-70">{sub}</div> : null}
    </div>
  );
}
