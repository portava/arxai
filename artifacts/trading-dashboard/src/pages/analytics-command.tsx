import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EquityCurveChart, DrawdownChart, StrategyAnalyticsTable,
  SessionHeatmap, EmotionalTrendGraph, RiskExposureGraph, ConsistencyTrendCard,
} from "@/components/analytics";
import type { AnalyticsSnapshot, StrategyRow, EquityPoint } from "@/components/analytics";

interface DrawdownResponse { equityCurve: EquityPoint[]; maxDrawdown: number }
interface SessionBucket { trades: number; pnl: number; wins: number }
type SessionData = Record<"ASIA"|"LONDON"|"NEWYORK", SessionBucket>;
interface EmotionalResponse { trend: Array<{ idx:number; isCalm:number; followedPlan:number; emotion:string }>; totalDebriefs: number }

export default function AnalyticsCommandCenter() {
  const qc = useQueryClient();
  const snap = useQuery<{ snapshot: AnalyticsSnapshot | null }>({
    queryKey: ["analytics-snapshot"],
    queryFn: async () => (await fetch("/api/analytics/snapshot")).json(),
  });
  const strat = useQuery<{ strategies: StrategyRow[] }>({
    queryKey: ["analytics-strategy"],
    queryFn: async () => (await fetch("/api/analytics/strategy")).json(),
  });
  const sess = useQuery<{ session: SessionData }>({
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

  const s = snap.data?.snapshot ?? null;

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Analytics Command Center</h1>
          <p className="text-xs text-txt-secondary">
            Institutional-style process analytics. Past performance does not predict future results.
          </p>
        </div>
        <button onClick={() => generate.mutate()} disabled={generate.isPending}
          className="rounded bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40">
          {generate.isPending ? "Computing…" : "Recompute snapshot"}
        </button>
      </header>

      {!s ? (
        <p className="rounded border border-dashed border-border p-6 text-center text-xs text-txt-muted">
          Computing your first analytics snapshot…
        </p>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Trades"        v={s.totalTrades.toString()} />
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
            <SessionHeatmap data={(sess.data?.session ?? {}) as any} />
          </div>

          <EmotionalTrendGraph trend={emo.data?.trend ?? []} />

          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Strategy Analytics</h3>
            <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <Highlight label="Strongest strategy"         v={s.strongestStrategy} tone="emerald" />
            <Highlight label="Weakest strategy"           v={s.weakestStrategy} tone="red" />
            <Highlight label="Strongest market condition" v={s.strongestMarketCondition} tone="emerald" />
            <Highlight label="Weakest market condition"   v={s.weakestMarketCondition} tone="red" />
          </section>

          <p className="text-[10px] italic text-txt-muted">
            Analytics summarize historical behavior and outcomes. Past performance does not predict future results.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: string; tone?: "emerald"|"red" }) {
  const t = tone === "emerald" ? "text-success" : tone === "red" ? "text-red-300" : "text-foreground";
  return (
    <div className="rounded border border-border bg-muted/50 p-2 text-center">
      <div className="text-[10px] uppercase tracking-wide text-txt-secondary">{label}</div>
      <div className={`text-base font-bold ${t}`}>{v}</div>
    </div>
  );
}
function Highlight({ label, v, tone }: { label: string; v: string | null; tone: "emerald"|"red" }) {
  const t = tone === "emerald" ? "border-success/40 bg-success/30 text-success" : "border-red-700 bg-red-950/30 text-red-100";
  return (
    <div className={`rounded border p-3 ${t}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-base font-semibold">{v ?? "—"}</div>
    </div>
  );
}
