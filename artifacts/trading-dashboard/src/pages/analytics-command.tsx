import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EquityCurveChart, DrawdownChart, StrategyAnalyticsTable,
  SessionHeatmap, EmotionalTrendGraph, RiskExposureGraph, ConsistencyTrendCard,
} from "@/components/analytics";
import type { AnalyticsSnapshot, AnalyticsCurrent, StrategyRow, EquityPoint } from "@/components/analytics";

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
  const s = live ?? saved;
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
            <Stat label="Net P&L"       v={`$${s.netProfitLoss.toFixed(0)}`} tone={s.netProfitLoss >= 0 ? "emerald" : "red"} />
            <Stat label="Win rate"      v={`${(s.winRate*100).toFixed(1)}%`} />
            <Stat label="Avg RR"        v={`${s.averageRr.toFixed(2)}R`} />
            <Stat label="Expectancy"    v={`$${s.expectancy.toFixed(2)}`} tone={s.expectancy >= 0 ? "emerald" : "red"} />
            <Stat label="Profit factor" v={s.profitFactor === 999 ? "∞" : s.profitFactor.toFixed(2)} />
            <Stat label="Max DD"        v={`$${s.maxDrawdown.toFixed(0)}`} tone="red" />
          </section>

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
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Strategy Analytics</h3>
            <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <Highlight label="Strongest strategy"         v={s.strongestStrategy} tone="emerald" />
            <Highlight label="Weakest strategy"           v={s.weakestStrategy} tone="red" />
            <Highlight label="Strongest market condition" v={s.strongestMarketCondition} tone="emerald" />
            <Highlight label="Weakest market condition"   v={s.weakestMarketCondition} tone="red" />
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
function Highlight({ label, v, tone }: { label: string; v: string | null; tone: "emerald"|"red" }) {
  const t = tone === "emerald" ? "border-emerald-700 bg-emerald-950/30 text-emerald-100" : "border-red-700 bg-red-950/30 text-red-100";
  return (
    <div className={`rounded border p-3 ${t}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-base font-semibold">{v ?? "—"}</div>
    </div>
  );
}
