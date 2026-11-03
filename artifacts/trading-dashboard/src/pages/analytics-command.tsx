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
  const same = (stored: number | null, now: number) =>
    stored != null && Number.isFinite(stored) && Number.isFinite(now) && Math.abs(stored - now) <= Math.max(0.01, Math.abs(now) * 1e-6);
  return s.totalTrades === live.pnlCoverage.closedTrades
    && same(s.netProfitLoss, netNow)
    && same(s.maxDrawdown, live.maxDrawdown)
    ? "matches" : "differs";
}

// A saved snapshot stores the plain top and bottom symbol by net P&L (the
// trade decision reads those columns), not the live, sign-checked best/worst.
const SAVED_BEST_SYMBOL_BASIS =
  "The symbol with the highest net P&L when the snapshot was saved. The saved snapshot does not record whether it was net profitable.";
// Snapshots saved before the edge board ranking ranked raw edge reports by
// confidence alone; later ones by edge status, then confidence. The row does
// not record which, so the card names the slice without claiming a ranking.
const SAVED_EDGE_SLICE_BASIS =
  "The edge slice named in the saved snapshot. The saved snapshot does not record how it was ranked, and it is not your results in a market condition.";
const SAVED_WORST_SYMBOL_BASIS =
  "The symbol with the lowest net P&L when the snapshot was saved. The saved snapshot does not record whether it was net losing, and with one traded symbol it is also the best.";

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
  // A failed reload keeps the last snapshot on screen (React Query keeps the
  // last good data). Say so, and whether a newer one was just computed.
  // The comparison is against the saved snapshot row (the figures computed
  // now carry no snapshot id).
  const computedId = (generate.data as { snapshot?: { id?: unknown } } | undefined)?.snapshot?.id;
  const newerComputed = generate.isSuccess && computedId != null && saved != null && computedId !== saved.id;
  // "saved <date, time>" from the stored row's timestamp, or says it was not reported.
  const savedPhrase = savedAt ? `saved ${savedAt}` : "whose save time was not reported";
  const reloadFailedText = !snap.isError
    ? null
    : live
      ? newerComputed
        ? `A new snapshot was computed, but it could not be loaded. ${errorMessage(snap.error)}. The figures below are from the last successful read, computed ${when(live.asOf) ?? "at an unknown time"}, not the snapshot just computed.`
        : `Your analytics could not be reloaded. ${errorMessage(snap.error)}. The figures below are from the last successful read, computed ${when(live.asOf) ?? "at an unknown time"}; trades closed since are not included.`
      : newerComputed
        ? `A new snapshot was computed, but it could not be loaded. ${errorMessage(snap.error)}. The figures below are from the earlier snapshot ${savedPhrase}, not the one just computed.`
        : `Your analytics snapshot could not be reloaded. ${errorMessage(snap.error)}. The figures below are from the snapshot ${savedPhrase}; a newer one may exist.`;

  // What the money figures cover: the live figures' own coverage (computed with
  // the tiles), else the drawdown or strategy response's. A saved snapshot's
  // money columns are NOT NULL, so one with no sizable trade holds 0 (or an
  // older Δprice × lots × 100 figure); the coverage says whether they are results.
  const coverage = live?.pnlCoverage ?? dd.data?.pnlCoverage ?? strat.data?.pnlCoverage ?? null;
  const coverageUnavailable = coverage == null && (dd.isError || dd.isSuccess);
  const pnlNotMeasured = coverage != null && coverage.closedTrades > 0 && coverage.sizedTrades === 0;
  // The coverage note describes figures computed now. Tiles computed now
  // carry it; tiles that fall back to the stored snapshot carry it only when
  // that row matches the figures computed now (checked against the stored
  // row itself, before any downgrade).
  const snapshotCheck: SnapshotCheck | null = !live && saved ? snapshotCheckOf(saved, dd) : null;
  const snapshotOutOfDate = !pnlNotMeasured && snapshotCheck === "differs";
  const noteCoversTiles = live != null || snapshotCheck === "matches";
  const savedTaken = saved ? utcStamp(saved.createdAt) : null;
  const money = (v: string) => (pnlNotMeasured ? NOT_MEASURED : snapshotOutOfDate ? OUT_OF_DATE : v);
  const moneyKnown = !pnlNotMeasured && !snapshotOutOfDate;
  const moneyTone = (positive: boolean): "emerald" | "red" | undefined => (!moneyKnown ? undefined : positive ? "emerald" : "red");
  // A money tile: "out of date" for a saved snapshot that no longer matches
  // (whatever it stored, even a downgraded null), else "—" when not measured,
  // else "not measured" when no trade could be sized, else the figure.
  const moneyTile = (x: number | null, fmt: (n: number) => string): string =>
    snapshotOutOfDate ? OUT_OF_DATE : x == null ? "—" : money(fmt(x));
  const unmeasuredLine = s ? notMeasuredLine(s, snapshotOutOfDate ? MONEY_FIGURES : []) : null;

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
            ? `The figures below are computed now from your paper orders; the saved snapshot${savedTaken ? ` (taken ${savedTaken})` : ""} was not updated.`
            : `The figures below are from the${savedTaken ? ` snapshot taken ${savedTaken}` : " previous snapshot"}.`}
        </p>
      )}

      {reloadFailedText && s && (
        <p role="alert" data-testid="analytics-snapshot-reload-failed" className="rounded border border-rose-700 p-2 text-xs text-rose-300">
          {reloadFailedText}
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
                "not measured", with the coverage note below; when a saved
                snapshot no longer matches the figures computed now, every
                money figure reads "out of date". */}
            <Stat id="net-pnl"       label="Net P&L (USD)" v={moneyTile(s.netProfitLoss, (n) => `$${n.toFixed(0)}`)} tone={s.netProfitLoss == null ? undefined : moneyTone(s.netProfitLoss >= 0)} />
            <Stat id="win-rate"      label="Win rate"      v={s.winRate == null ? "—" : `${(s.winRate*100).toFixed(1)}%`} />
            <Stat id="avg-rr"        label="Avg RR"        v={s.averageRr == null ? "—" : `${s.averageRr.toFixed(2)}R`} />
            <Stat id="expectancy"    label="Expectancy"    v={moneyTile(s.expectancy, (n) => `$${n.toFixed(2)}`)} tone={s.expectancy == null ? undefined : moneyTone(s.expectancy >= 0)} />
            <Stat id="profit-factor" label="Profit factor" v={moneyTile(s.profitFactor, (n) => n.toFixed(2))} />
            <Stat id="max-dd"        label="Max DD"        v={moneyTile(s.maxDrawdown, (n) => `$${n.toFixed(0)}`)} tone={moneyKnown && s.maxDrawdown != null && s.maxDrawdown > 0 ? "red" : undefined} />
          </section>
          {unmeasuredLine ? (
            <p className="text-[11px] text-slate-400" data-testid="analytics-unmeasured">{unmeasuredLine}</p>
          ) : null}

          {/* Tiles from a saved snapshot (no figures computed now): whether
              that stored row still matches your closed trades computed now. */}
          {snapshotCheck ? (
            <p className={`text-[11px] ${snapshotCheck === "differs" || snapshotCheck === "unchecked" ? "text-amber-300" : "text-slate-400"}`}
              data-testid="analytics-snapshot-asof">
              {`These figures are from your stored analytics snapshot${savedTaken ? ` taken ${savedTaken}` : " (its time was not recorded)"}`}
              {snapshotCheck === "matches"
                ? ". They match your closed trades as computed now."
                : snapshotCheck === "differs"
                  ? `. They no longer match your closed trades as computed now (${dd.data?.pnlCoverage?.closedTrades ?? "?"} closed trades)` +
                    // With no trade sized in USD the money tiles read "not
                    // measured", and recomputing does not change that.
                    (pnlNotMeasured
                      ? ". No money figure is shown because none of your closed trades could be sized in USD. Recompute snapshot updates the trade count, win rate and other non-money figures; it does not produce money figures."
                      : `${snapshotOutOfDate ? ", so its money figures are shown as out of date" : ""}. Use Recompute snapshot to update them.`)
                  : snapshotCheck === "unchecked"
                    ? ". Whether they match your closed trades now could not be checked."
                    : ". Checking them against your closed trades now…"}
            </p>
          ) : null}

          {/* What the money figures are and cover: USD at contract size,
              recomputed from fill prices (not the booked demo P&L Ruby Memory
              shows), and which closed trades could not be sized. */}
          <p className={`text-[11px] ${pnlNotMeasured || coverageUnavailable ? "text-amber-300" : "text-slate-400"}`} data-testid="analytics-pnl-coverage">
            {coverage
              // Unless the tiles were computed now or the saved snapshot was
              // checked against it, the note covers only the figures computed
              // now (charts and tables below).
              ? noteCoversTiles ? coverage.note : `Computed now from your closed trades: ${coverage.note}`
              : coverageUnavailable
                ? "Which closed trades could be sized in USD could not be loaded, so it is not known whether these money figures cover every closed trade."
                : "Checking which closed trades could be sized in USD…"}
          </p>

          {dd.isError ? (
            <LoadError what="The equity curve and drawdown" error={dd.error} />
          ) : dd.isPending ? (
            <Loading text="Loading the equity curve…" />
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
              : sess.isPending
                ? <Loading text="Loading session performance…" />
              : pnlNotMeasured && coverage
                ? <Unavailable text={`Session Heatmap: ${coverage.note}`} />
                : <SessionHeatmap data={sess.data?.session ?? null} basis={sess.data?.sessionBasis} loading={sess.isPending} />}
          </div>

          {emo.isError
            ? <LoadError what="The emotional trend" error={emo.error} />
            : emo.isPending
              ? <Loading text="Loading the emotional trend…" />
            : <EmotionalTrendGraph trend={emo.data?.trend ?? []} />}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Results by symbol</h3>
            {strat.isError
              ? <LoadError what="Strategy analytics" error={strat.error} />
              : strat.isPending
                ? <Loading text="Loading strategy analytics…" />
              : pnlNotMeasured && coverage
                ? <Unavailable text={coverage.note} />
                : <StrategyAnalyticsTable rows={strat.data?.strategies ?? []} coverage={strat.data?.pnlCoverage ?? null} loading={strat.isPending} />}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            {/* These group by SYMBOL and by Edge Discovery slice: paper orders
                carry no strategy, and no edge report records a market condition.
                Best / worst symbol rank by money, so they are "not measured"
                when no closed trade could be sized, and "out of date" when the
                saved snapshot no longer matches the figures computed now. */}
            <Highlight id="best-symbol"  label="Best symbol (net P&L)"  v={!moneyKnown ? money("") : live ? live.strongestSymbol ?? null : s.strongestStrategy} tone="emerald" empty="No symbol is net profitable"
              sub={live?.highlightBasis?.symbols ?? SAVED_BEST_SYMBOL_BASIS} />
            <Highlight id="worst-symbol" label="Worst symbol (net P&L)" v={!moneyKnown ? money("") : live ? live.weakestSymbol ?? null : s.weakestStrategy} tone="red" empty="No symbol is net losing"
              sub={live?.highlightBasis?.symbols ?? SAVED_WORST_SYMBOL_BASIS} />
            <Highlight id="strongest-edge" label="Strongest edge slice" v={live ? edgeSliceText(live.strongestEdgeSlice) : s.strongestMarketCondition} tone="emerald" empty="No slice is rated a strong or developing edge"
              sub={live?.highlightBasis?.edgeSlices ?? SAVED_EDGE_SLICE_BASIS} />
            <Highlight id="weakest-edge" label="Weakest edge slice" v={live ? edgeSliceText(live.weakestEdgeSlice) : s.weakestMarketCondition} tone="red" empty="No slice is rated a weak or no edge"
              sub={live?.highlightBasis?.edgeSlices ?? SAVED_EDGE_SLICE_BASIS} />
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
// A section whose read has not answered yet: never an empty or zero state.
function Loading({ text }: { text: string }) {
  return <p className="p-3 text-center text-[11px] text-slate-500">{text}</p>;
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
/** The money tiles: they read "out of date" together when a saved snapshot no longer matches. */
const MONEY_FIGURES: readonly string[] = ["netProfitLoss", "expectancy", "profitFactor", "maxDrawdown"];
/**
 * "Not measured: Win rate (No closed paper trades yet); ..." for the tiles
 * above, leaving out `skip` (tiles that read "out of date" instead).
 */
function notMeasuredLine(f: AnalyticsFigures, skip: readonly string[]): string | null {
  const parts = Object.entries(FIGURE_LABELS)
    .filter(([k]) => !skip.includes(k) && f[k as keyof AnalyticsFigures] == null)
    .map(([k, label]) => {
      const why = f.unmeasured?.[k];
      return why ? `${label} (${why.endsWith(".") ? why.slice(0, -1) : why})` : label;
    });
  return parts.length ? `Not measured: ${parts.join("; ")}.` : null;
}

/**
 * A saved snapshot's columns are NOT NULL, so "not measured" was stored as 0
 * (and a profit factor with no losing trade as 999). Downgrade what the row
 * itself shows was not measured. A stored 0 money figure, R or behaviour score
 * is ambiguous — a measured 0 and a figure that could not be measured (no
 * trade sized in USD, no stop distance, no debrief) are stored alike — so it
 * is "—" with that reason, never a $0 or a red 0/100. A win rate needs no
 * sizing, so 0% of N closed trades is a result.
 */
const SAVED_ZERO_WHY =
  "A saved snapshot stores 0 both for a measured 0 and for a figure it could not measure, so this cannot be told from it. Recompute to see the current figure.";
function downgradeSaved(r: AnalyticsSnapshot): AnalyticsFigures {
  const noTrades = r.totalTrades === 0;
  const why = "No closed paper trades when this snapshot was saved.";
  const unmeasured: Record<string, string> = {};
  const money = (k: string, v: number | null): number | null => {
    if (noTrades) { unmeasured[k] = why; return null; }
    if (v === 0) { unmeasured[k] = SAVED_ZERO_WHY; return null; }
    return v;
  };
  const score = (k: string, v: number | null): number | null => {
    if (v === 0) { unmeasured[k] = SAVED_ZERO_WHY; return null; }
    return v;
  };
  if (noTrades) unmeasured["winRate"] = why;
  const profitFactor = !noTrades && r.profitFactor === 999
    ? (unmeasured["profitFactor"] = "No losing trade, so gross win ÷ gross loss is undefined.", null)
    : money("profitFactor", r.profitFactor);
  return {
    ...r,
    netProfitLoss: money("netProfitLoss", r.netProfitLoss),
    winRate: noTrades ? null : r.winRate,
    averageRr: money("averageRr", r.averageRr),
    expectancy: money("expectancy", r.expectancy),
    profitFactor,
    maxDrawdown: money("maxDrawdown", r.maxDrawdown),
    disciplineScoreAvg: score("disciplineScoreAvg", r.disciplineScoreAvg),
    executionScoreAvg: score("executionScoreAvg", r.executionScoreAvg),
    emotionalScoreAvg: score("emotionalScoreAvg", r.emotionalScoreAvg),
    consistencyScoreAvg: score("consistencyScoreAvg", r.consistencyScoreAvg),
    unmeasured,
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
