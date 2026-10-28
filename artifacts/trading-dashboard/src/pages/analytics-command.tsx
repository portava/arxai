import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { safeJson } from "@/lib/api/safeJson";
import {
  EquityCurveChart, DrawdownChart, StrategyAnalyticsTable,
  SessionHeatmap, EmotionalTrendGraph, RiskExposureGraph, ConsistencyTrendCard,
} from "@/components/analytics";
import type { AnalyticsSnapshot, StrategyRow, EquityPoint } from "@/components/analytics";

interface DrawdownResponse { equityCurve: EquityPoint[]; maxDrawdown: number }
interface SessionBucket { trades: number; pnl: number; wins: number }
type SessionData = Record<"ASIA"|"LONDON"|"NEWYORK", SessionBucket>;
interface EmotionalResponse { trend: Array<{ idx:number; isCalm:number; followedPlan:number; emotion:string }>; totalDebriefs: number }

// Reads an analytics endpoint and throws on a non-2xx status or an unreadable
// body, so a failed read is an error state rather than an empty result.
async function getAnalyticsJson<T>(url: string, action: string, init?: RequestInit): Promise<T> {
  const r = await safeJson<T>(url, init);
  if (!r.ok) throw new Error(`${action} failed (${r.message})`);
  return r.data;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

export default function AnalyticsCommandCenter() {
  const qc = useQueryClient();
  const snap = useQuery<{ snapshot: AnalyticsSnapshot | null }>({
    queryKey: ["analytics-snapshot"],
    queryFn: () => getAnalyticsJson("/api/analytics/snapshot", "Loading the analytics snapshot"),
  });
  const strat = useQuery<{ strategies: StrategyRow[] }>({
    queryKey: ["analytics-strategy"],
    queryFn: () => getAnalyticsJson("/api/analytics/strategy", "Loading strategy analytics"),
  });
  const sess = useQuery<{ session: SessionData }>({
    queryKey: ["analytics-session"],
    queryFn: () => getAnalyticsJson("/api/analytics/session", "Loading session analytics"),
  });
  const emo = useQuery<EmotionalResponse>({
    queryKey: ["analytics-emotional"],
    queryFn: () => getAnalyticsJson("/api/analytics/emotional", "Loading emotional trend"),
  });
  const dd = useQuery<DrawdownResponse>({
    queryKey: ["analytics-drawdown"],
    queryFn: () => getAnalyticsJson("/api/analytics/drawdown", "Loading equity and drawdown"),
  });

  const generate = useMutation({
    mutationFn: () => getAnalyticsJson<unknown>("/api/analytics/snapshot", "Computing the analytics snapshot", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics-snapshot"] }),
  });

  // Auto-generate the first snapshot if the server confirmed none exists. This
  // runs at most once per page visit: a failed or empty computation is shown
  // as such, and further attempts are the user's choice (Recompute).
  const autoGenerateTried = useRef(false);
  useEffect(() => {
    if (autoGenerateTried.current) return;
    if (snap.isSuccess && snap.data?.snapshot === null && !generate.isPending) {
      autoGenerateTried.current = true;
      generate.mutate();
    }
  }, [snap.isSuccess, snap.data?.snapshot, generate]);

  const s = snap.data?.snapshot ?? null;
  const snapshotState: string = snap.isError
    ? `Could not load your analytics snapshot. ${errorMessage(snap.error)}`
    : snap.isPending
      ? "Loading your latest analytics snapshot…"
      : generate.isPending
        ? "Computing your first analytics snapshot…"
        : generate.isError
          ? `Your analytics snapshot could not be computed. ${errorMessage(generate.error)}. Nothing is computing; use Recompute snapshot to try again.`
          : "No analytics snapshot yet. Use Recompute snapshot to compute one.";
  const snapshotFailed = snap.isError || generate.isError;

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

      {generate.isError && s && (
        <p role="alert" className="rounded border border-rose-700 p-2 text-xs text-rose-300">
          The snapshot could not be recomputed. {errorMessage(generate.error)}. The figures below are from the previous snapshot.
        </p>
      )}

      {!s ? (
        <p data-testid="analytics-snapshot-state" role={snapshotFailed ? "alert" : undefined}
          className={`rounded border border-dashed p-6 text-center text-xs ${snapshotFailed ? "border-rose-700 text-rose-300" : "border-slate-700 text-slate-500"}`}>
          {snapshotState}
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

          {dd.isError ? (
            <LoadError what="The equity curve and drawdown" error={dd.error} />
          ) : dd.isPending ? (
            <p className="p-3 text-center text-[11px] text-slate-500">Loading the equity curve…</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <EquityCurveChart points={dd.data?.equityCurve ?? []} />
              <DrawdownChart    points={dd.data?.equityCurve ?? []} maxDrawdown={dd.data?.maxDrawdown ?? 0} />
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-3">
            <RiskExposureGraph snapshot={s} />
            <ConsistencyTrendCard snapshot={s} />
            {sess.isError
              ? <LoadError what="Session performance" error={sess.error} />
              : <SessionHeatmap data={(sess.data?.session ?? {}) as any} />}
          </div>

          {emo.isError
            ? <LoadError what="The emotional trend" error={emo.error} />
            : <EmotionalTrendGraph trend={emo.data?.trend ?? []} />}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Strategy Analytics</h3>
            {strat.isError
              ? <LoadError what="Strategy analytics" error={strat.error} />
              : <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} />}
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

function LoadError({ what, error }: { what: string; error: unknown }) {
  return (
    <p role="alert" className="rounded border border-dashed border-rose-700 p-3 text-center text-[11px] text-rose-300">
      {what} could not be loaded. {errorMessage(error)}
    </p>
  );
}
function Stat({ label, v, tone }: { label: string; v: string; tone?: "emerald"|"red" }) {
  const t = tone === "emerald" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-slate-100";
  return (
    <div className="rounded border border-slate-700 bg-slate-900/50 p-2 text-center">
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
