import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { safeJson } from "@/lib/api/safeJson";
import {
  EquityCurveChart, DrawdownChart, StrategyAnalyticsTable,
  SessionHeatmap, EmotionalTrendGraph, RiskExposureGraph, ConsistencyTrendCard,
} from "@/components/analytics";
import type { AnalyticsFigures, AnalyticsSnapshot, AnalyticsCurrent, StrategyRow, EquityPoint } from "@/components/analytics";
import type { EdgeSliceHighlight } from "@/components/analytics/types";

/**
 * What the money figures cover (routes/analytics.ts pnlCoverageOf). A closed
 * trade that cannot be sized in USD is left out of every money figure.
 */
interface PnlCoverage {
  closedTrades: number; sizedTrades: number; unsizedTrades: number;
  unsizedSymbols: string[]; note: string;
}
interface DrawdownResponse { equityCurve: EquityPoint[]; maxDrawdown: number; pnlCoverage?: PnlCoverage }
interface SessionBucket { trades: number; pnl: number; wins: number; sizedTrades?: number }
type SessionData = Record<"ASIA"|"LONDON"|"NEWYORK", SessionBucket>;
interface EmotionalResponse { trend: Array<{ idx:number; isCalm:number; followedPlan:number; emotion:string }>; totalDebriefs: number }

// Reads an analytics endpoint and throws on a non-2xx status, an unreadable
// body or a null body, so a failed read is an error state ("could not be
// loaded") rather than an empty result.
async function getAnalyticsJson<T>(url: string, action: string, init?: RequestInit): Promise<T> {
  const r = await safeJson<T>(url, init);
  if (!r.ok) throw new Error(`${action} failed (${r.message})`);
  if (r.data == null) throw new Error(`${action} failed (empty response)`);
  return r.data;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

const NOT_MEASURED = "not measured";

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
    queryFn: () => getAnalyticsJson<SnapshotResponse>("/api/analytics/snapshot", "Loading the analytics snapshot"),
  });
  const strat = useQuery<{ strategies: StrategyRow[]; pnlCoverage?: PnlCoverage }>({
    queryKey: ["analytics-strategy"],
    queryFn: () => getAnalyticsJson<{ strategies: StrategyRow[]; pnlCoverage?: PnlCoverage }>("/api/analytics/strategy", "Loading strategy analytics"),
  });
  const sess = useQuery<{ session: SessionData; sessionBasis?: string }>({
    queryKey: ["analytics-session"],
    queryFn: () => getAnalyticsJson<{ session: SessionData; sessionBasis?: string }>("/api/analytics/session", "Loading session analytics"),
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

  // What the money figures cover: the live figures' own coverage (computed with
  // the tiles), else the drawdown or strategy response's. A saved snapshot's
  // money columns are NOT NULL, so one with no sizable trade holds 0 (or an
  // older Δprice × lots × 100 figure); the coverage says whether they are results.
  const coverage = live?.pnlCoverage ?? dd.data?.pnlCoverage ?? strat.data?.pnlCoverage ?? null;
  const coverageUnavailable = coverage == null && (dd.isError || dd.isSuccess);
  const pnlNotMeasured = coverage != null && coverage.closedTrades > 0 && coverage.sizedTrades === 0;
  const money = (v: string) => (pnlNotMeasured ? NOT_MEASURED : v);
  const moneyTone = (positive: boolean): "emerald" | "red" | undefined => (pnlNotMeasured ? undefined : positive ? "emerald" : "red");

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
          The snapshot could not be recomputed. {errorMessage(generate.error)}. {live
            ? "The figures below are computed now from your paper orders; the saved snapshot was not updated."
            : "The figures below are from the previous snapshot."}
        </p>
      )}

      {!s ? (
        <p data-testid="analytics-snapshot-state" role={snapshotFailed ? "alert" : undefined}
          className={`rounded border border-dashed p-6 text-center text-xs ${snapshotFailed ? "border-rose-700 text-rose-300" : "border-slate-700 text-slate-500"}`}>
          {snapshotState}
        </p>
      ) : (
        <>
          <p className={`text-[11px] ${live ? "text-slate-400" : "text-amber-300"}`} data-testid="analytics-asof">{asOfLine}</p>

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <Stat id="trades"        label="Trades"        v={s.totalTrades.toString()} />
            {/* null = not measured: "—", no colour, and the reason below. When no
                closed trade could be sized in USD every money figure reads
                "not measured", with the coverage note below. */}
            <Stat id="net-pnl"       label="Net P&L (USD)" v={s.netProfitLoss == null ? "—" : money(`$${s.netProfitLoss.toFixed(0)}`)} tone={s.netProfitLoss == null ? undefined : moneyTone(s.netProfitLoss >= 0)} />
            <Stat id="win-rate"      label="Win rate"      v={s.winRate == null ? "—" : `${(s.winRate*100).toFixed(1)}%`} />
            <Stat id="avg-rr"        label="Avg RR"        v={s.averageRr == null ? "—" : `${s.averageRr.toFixed(2)}R`} />
            <Stat id="expectancy"    label="Expectancy"    v={s.expectancy == null ? "—" : money(`$${s.expectancy.toFixed(2)}`)} tone={s.expectancy == null ? undefined : moneyTone(s.expectancy >= 0)} />
            <Stat id="profit-factor" label="Profit factor" v={s.profitFactor == null ? "—" : money(s.profitFactor.toFixed(2))} />
            <Stat id="max-dd"        label="Max DD"        v={s.maxDrawdown == null ? "—" : money(`$${s.maxDrawdown.toFixed(0)}`)} tone={!pnlNotMeasured && s.maxDrawdown != null && s.maxDrawdown > 0 ? "red" : undefined} />
          </section>
          {notMeasuredLine(s) ? (
            <p className="text-[11px] text-slate-400" data-testid="analytics-unmeasured">{notMeasuredLine(s)}</p>
          ) : null}

          {/* What the money figures are and cover: USD at contract size,
              recomputed from fill prices (not the booked demo P&L Ruby Memory
              shows), and which closed trades could not be sized. */}
          <p className={`text-[11px] ${pnlNotMeasured || coverageUnavailable ? "text-amber-300" : "text-slate-400"}`} data-testid="analytics-pnl-coverage">
            {coverage
              ? coverage.note
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
              : <RiskExposureGraph snapshot={s} />}
            <ConsistencyTrendCard snapshot={s} />
            {sess.isError
              ? <LoadError what="Session performance" error={sess.error} />
              : pnlNotMeasured && coverage
                ? <Unavailable text={`Session Heatmap: ${coverage.note}`} />
                : <SessionHeatmap data={(sess.data?.session ?? {}) as any} basis={sess.data?.sessionBasis} />}
          </div>

          {emo.isError
            ? <LoadError what="The emotional trend" error={emo.error} />
            : <EmotionalTrendGraph trend={emo.data?.trend ?? []} />}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Results by symbol</h3>
            {strat.isError
              ? <LoadError what="Strategy analytics" error={strat.error} />
              : pnlNotMeasured && coverage
                ? <Unavailable text={coverage.note} />
                : <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} />}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            {/* These group by SYMBOL and by Edge Discovery slice: paper orders
                carry no strategy, and no edge report records a market condition.
                Best / worst symbol rank by money, so they are "not measured"
                when no closed trade could be sized. */}
            <Highlight id="best-symbol"  label="Best symbol (net P&L)"  v={pnlNotMeasured ? NOT_MEASURED : live ? live.strongestSymbol ?? null : s.strongestStrategy} tone="emerald" empty="No symbol is net profitable"
              sub={live?.highlightBasis?.symbols ?? "Highest net P&L among symbols when the snapshot was saved."} />
            <Highlight id="worst-symbol" label="Worst symbol (net P&L)" v={pnlNotMeasured ? NOT_MEASURED : live ? live.weakestSymbol ?? null : s.weakestStrategy} tone="red" empty="No symbol is net losing"
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

function LoadError({ what, error }: { what: string; error: unknown }) {
  return (
    <p role="alert" className="rounded border border-dashed border-rose-700 p-3 text-center text-[11px] text-rose-300">
      {what} could not be loaded. {errorMessage(error)}
    </p>
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
function Unavailable({ text }: { text: string }) {
  return (
    <p className="rounded border border-dashed border-slate-700 p-3 text-center text-[11px] text-slate-400">{text}</p>
  );
}
