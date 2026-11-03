import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { safeJson } from "@/lib/api/safeJson";
import {
  EquityCurveChart, DrawdownChart, StrategyAnalyticsTable,
  SessionHeatmap, EmotionalTrendGraph, RiskExposureGraph, ConsistencyTrendCard,
} from "@/components/analytics";
import type { AnalyticsSnapshot, StrategyRow, EquityPoint } from "@/components/analytics";

/**
 * What the money figures cover (routes/analytics.ts pnlCoverageOf). A closed
 * trade that cannot be sized in USD is left out of every money figure.
 */
interface PnlCoverage {
  closedTrades: number; sizedTrades: number; unsizedTrades: number;
  unsizedSymbols: string[]; note: string;
}
interface DrawdownResponse { equityCurve: EquityPoint[]; maxDrawdown: number; pnlCoverage?: PnlCoverage }
/** pnl sums only the session's sized trades; sizedTrades says how many. */
interface SessionBucket { trades: number; pnl: number; wins: number; sizedTrades?: number }
type SessionData = Record<"ASIA"|"LONDON"|"NEWYORK", SessionBucket>;
interface EmotionalResponse { trend: Array<{ idx:number; isCalm:number; followedPlan:number; emotion:string }>; totalDebriefs: number }

// Reads an analytics endpoint and throws on a non-2xx status, an unreadable
// body or a null body, so a failed read is an error state ("could not be
// loaded") rather than an empty result.
async function getAnalyticsJson<T>(url: string, action: string, init?: RequestInit): Promise<T> {
  const r = await safeJson<T>(url, init);
  if (!r.ok) {
    // Name the HTTP status as well as the server's reason ("HTTP 500: ...").
    const detail = r.kind === "http" && !r.message.startsWith("HTTP ") ? `HTTP ${r.status}: ${r.message}` : r.message;
    throw new Error(`${action} failed (${detail})`);
  }
  if (r.data == null) throw new Error(`${action} failed (empty response)`);
  return r.data;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

const NOT_MEASURED = "not measured";
const OUT_OF_DATE = "out of date";

/** "2026-10-27 09:00 UTC", or null when the time is missing or unreadable. */
function utcStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Does the stored snapshot hold the same figures as your closed trades give
 * when computed now (GET /analytics/drawdown, on the basis its pnlCoverage
 * note states)? A snapshot is a stored row: one written before contract-size
 * P&L holds Δprice × lots × 100 figures, and one written before later trades
 * closed misses them. Its money columns are float4, hence the tolerance.
 */
type SnapshotCheck = "checking" | "unchecked" | "matches" | "differs";
function snapshotCheckOf(
  s: AnalyticsSnapshot,
  dd: { isPending: boolean; isError: boolean; data?: DrawdownResponse },
): SnapshotCheck {
  if (dd.isPending) return "checking";
  const live = dd.data;
  if (dd.isError || !live?.pnlCoverage || !Array.isArray(live.equityCurve)) return "unchecked";
  const curve = live.equityCurve;
  const netNow = curve.length ? curve[curve.length - 1]!.equity : 0;
  const same = (stored: number, now: number) =>
    Number.isFinite(stored) && Number.isFinite(now) && Math.abs(stored - now) <= Math.max(0.01, Math.abs(now) * 1e-6);
  return s.totalTrades === live.pnlCoverage.closedTrades
    && same(s.netProfitLoss, netNow)
    && same(s.maxDrawdown, live.maxDrawdown)
    ? "matches" : "differs";
}

export default function AnalyticsCommandCenter() {
  const qc = useQueryClient();
  const snap = useQuery<{ snapshot: AnalyticsSnapshot | null }>({
    queryKey: ["analytics-snapshot"],
    queryFn: () => getAnalyticsJson<{ snapshot: AnalyticsSnapshot | null }>("/api/analytics/snapshot", "Loading the analytics snapshot"),
  });
  const strat = useQuery<{ strategies: StrategyRow[]; pnlCoverage?: PnlCoverage }>({
    queryKey: ["analytics-strategy"],
    queryFn: () => getAnalyticsJson<{ strategies: StrategyRow[]; pnlCoverage?: PnlCoverage }>("/api/analytics/strategy", "Loading strategy analytics"),
  });
  const sess = useQuery<{ session: SessionData }>({
    queryKey: ["analytics-session"],
    queryFn: () => getAnalyticsJson<{ session: SessionData }>("/api/analytics/session", "Loading session analytics"),
  });
  const emo = useQuery<EmotionalResponse>({
    queryKey: ["analytics-emotional"],
    queryFn: () => getAnalyticsJson<EmotionalResponse>("/api/analytics/emotional", "Loading emotional trend"),
  });
  const dd = useQuery<DrawdownResponse>({
    queryKey: ["analytics-drawdown"],
    queryFn: () => getAnalyticsJson<DrawdownResponse>("/api/analytics/drawdown", "Loading equity and drawdown"),
  });

  const generate = useMutation({
    mutationFn: () => getAnalyticsJson<unknown>("/api/analytics/snapshot", "Computing the analytics snapshot", { method: "POST" }),
    // Re-read the live equity/drawdown too, so the new snapshot is checked
    // against trades read at the same time.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["analytics-snapshot"] });
      void qc.invalidateQueries({ queryKey: ["analytics-drawdown"] });
    },
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
    ? `The analytics snapshot could not be loaded. ${errorMessage(snap.error)}`
    : snap.isPending
      ? "Loading your latest analytics snapshot…"
      : generate.isPending
        ? "Computing your first analytics snapshot…"
        : generate.isError
          ? `Your analytics snapshot could not be computed. ${errorMessage(generate.error)}. Nothing is computing; use Recompute snapshot to try again.`
          : "No analytics snapshot yet. Use Recompute snapshot to compute one.";
  const snapshotFailed = snap.isError || generate.isError;

  // The stored snapshot's money columns are NOT NULL, so a snapshot with no
  // sizable trade holds 0 (or an older Δprice × lots × 100 figure). The
  // current coverage (drawdown response) says whether they are results.
  const coverage = dd.data?.pnlCoverage ?? strat.data?.pnlCoverage ?? null;
  const coverageUnavailable = coverage == null && (dd.isError || dd.isSuccess);
  const pnlNotMeasured = coverage != null && coverage.closedTrades > 0 && coverage.sizedTrades === 0;
  // The coverage note describes figures computed now. The tiles come from the
  // stored snapshot, so they carry it only when they match those figures.
  const snapshotCheck: SnapshotCheck | null = s ? snapshotCheckOf(s, dd) : null;
  const snapshotOutOfDate = !pnlNotMeasured && snapshotCheck === "differs";
  const snapshotTaken = s ? utcStamp(s.createdAt) : null;
  const money = (v: string) => (pnlNotMeasured ? NOT_MEASURED : snapshotOutOfDate ? OUT_OF_DATE : v);
  const moneyKnown = !pnlNotMeasured && !snapshotOutOfDate;
  const moneyTone = (positive: boolean): "emerald" | "red" | undefined => (!moneyKnown ? undefined : positive ? "emerald" : "red");

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
          The snapshot could not be recomputed. {errorMessage(generate.error)}. The figures below are from the
          {snapshotTaken ? ` snapshot taken ${snapshotTaken}` : " previous snapshot"}.
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
            <Stat id="trades"        label="Trades"        v={s.totalTrades.toString()} />
            <Stat id="net-p-l"       label="Net P&L"       v={money(`$${s.netProfitLoss.toFixed(0)}`)} tone={moneyTone(s.netProfitLoss >= 0)} />
            <Stat id="win-rate"      label="Win rate"      v={`${(s.winRate*100).toFixed(1)}%`} />
            <Stat id="avg-rr"        label="Avg RR"        v={`${s.averageRr.toFixed(2)}R`} />
            <Stat id="expectancy"    label="Expectancy"    v={money(`$${s.expectancy.toFixed(2)}`)} tone={moneyTone(s.expectancy >= 0)} />
            <Stat id="profit-factor" label="Profit factor" v={money(s.profitFactor === 999 ? "∞" : s.profitFactor.toFixed(2))} />
            <Stat id="max-dd"        label="Max DD"        v={money(`$${s.maxDrawdown.toFixed(0)}`)} tone={moneyKnown ? "red" : undefined} />
          </section>

          <p className={`text-[11px] ${snapshotCheck === "differs" || snapshotCheck === "unchecked" ? "text-amber-300" : "text-slate-400"}`}
            data-testid="analytics-snapshot-asof">
            {`These figures are from your stored analytics snapshot${snapshotTaken ? ` taken ${snapshotTaken}` : " (its time was not recorded)"}`}
            {snapshotCheck === "matches"
              ? ". They match your closed trades as computed now."
              : snapshotCheck === "differs"
                ? `. They no longer match your closed trades as computed now (${dd.data?.pnlCoverage?.closedTrades ?? "?"} closed trades), so its money figures are shown as out of date. Use Recompute snapshot to update them.`
                : snapshotCheck === "unchecked"
                  ? ". Whether they match your closed trades now could not be checked."
                  : ". Checking them against your closed trades now…"}
          </p>

          <p className={`text-[11px] ${pnlNotMeasured || coverageUnavailable ? "text-amber-300" : "text-slate-400"}`} data-testid="analytics-pnl-coverage">
            {coverage
              // Unless the snapshot was checked against it, the note covers
              // only the figures computed now (charts and tables below).
              ? snapshotCheck === "matches" ? coverage.note : `Computed now from your closed trades: ${coverage.note}`
              : coverageUnavailable
                ? "Which closed trades could be sized in USD could not be loaded, so it is not known whether these money figures cover every closed trade."
                : "Checking which closed trades could be sized in USD…"}
          </p>

          {dd.isError ? (
            <LoadError what="The equity curve and drawdown" error={dd.error} />
          ) : dd.isPending ? (
            <p className="p-3 text-center text-[11px] text-slate-500">Loading the equity curve…</p>
          ) : pnlNotMeasured && coverage ? (
            <Unavailable text={coverage.note} />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <EquityCurveChart points={dd.data?.equityCurve ?? []} />
              <DrawdownChart    points={dd.data?.equityCurve ?? []} maxDrawdown={dd.data?.maxDrawdown ?? 0} />
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-3">
            {pnlNotMeasured && coverage
              ? <Unavailable text={`Risk Exposure: ${coverage.note}`} />
              : snapshotOutOfDate
                ? <Unavailable text="Risk Exposure: the stored snapshot's figures are out of date. Use Recompute snapshot to update them." />
                : <RiskExposureGraph snapshot={s} />}
            <ConsistencyTrendCard snapshot={s} />
            {sess.isError
              ? <LoadError what="Session performance" error={sess.error} />
              : pnlNotMeasured && coverage
                ? <Unavailable text={`Session Heatmap: ${coverage.note}`} />
                : <SessionHeatmap data={sess.data?.session ?? {}} />}
          </div>

          {emo.isError
            ? <LoadError what="The emotional trend" error={emo.error} />
            : <EmotionalTrendGraph trend={emo.data?.trend ?? []} />}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Strategy Analytics</h3>
            {strat.isError
              ? <LoadError what="Strategy analytics" error={strat.error} />
              : pnlNotMeasured && coverage
                ? <Unavailable text={coverage.note} />
                : <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} />}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <Highlight id="strongest-strategy" label="Strongest strategy"         v={moneyKnown ? s.strongestStrategy : money("")} tone="emerald" />
            <Highlight id="weakest-strategy"   label="Weakest strategy"           v={moneyKnown ? s.weakestStrategy : money("")} tone="red" />
            <Highlight id="strongest-market-condition" label="Strongest market condition" v={s.strongestMarketCondition} tone="emerald" />
            <Highlight id="weakest-market-condition"   label="Weakest market condition"   v={s.weakestMarketCondition} tone="red" />
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
function Stat({ id, label, v, tone }: { id: string; label: string; v: string; tone?: "emerald"|"red" }) {
  const t = tone === "emerald" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-slate-100";
  return (
    <div className="rounded border border-slate-700 bg-slate-900/50 p-2 text-center" data-testid={`stat-${id}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-base font-bold ${t}`}>{v}</div>
    </div>
  );
}
function Highlight({ id, label, v, tone }: { id: string; label: string; v: string | null; tone: "emerald"|"red" }) {
  const t = tone === "emerald" ? "border-emerald-700 bg-emerald-950/30 text-emerald-100" : "border-red-700 bg-red-950/30 text-red-100";
  return (
    <div className={`rounded border p-3 ${t}`} data-testid={`highlight-${id}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-base font-semibold">{v ?? "—"}</div>
    </div>
  );
}
function Unavailable({ text }: { text: string }) {
  return (
    <p className="rounded border border-dashed border-slate-700 p-3 text-center text-[11px] text-slate-400">{text}</p>
  );
}
