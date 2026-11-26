import { useCallback, useEffect, useRef, useState } from "react";
import { brier, probabilities, independentForecasts, logLoss, scenarioIndex, favoredScenario, scoreClosePath, forecastRangeCoverage, uniqueHorizonScores, FORECAST_HORIZONS, DEFAULT_FORECAST_HORIZON, forecastHorizon, FIT_WINDOW_BARS, FORECAST_INPUT_BARS, MIN_FIT_WINDOWS, type ForecastHorizonPreset, type ForecastRoute, type ForecastScore, type StructuralBar, type StructuralForecast, type Scenario, type Trajectory, type TrajectoryKind, type Triple, type CalibrationRecord, type ForecastGrade, type ForecastPaperGrade } from "@workspace/domain/structural";
import { Button } from "@/components/ui/button";
import { resolveArxMarket } from "@workspace/domain/market";

interface Row { id: string; issuedAt: number; forecast: StructuralForecast; scores: ForecastScore[]; paperPublishedAt?: number; paperGrade?: ForecastPaperGrade }
const labels: Record<Scenario, string> = { UP_FIRST: "Bullish first", DOWN_FIRST: "Bearish first", NEITHER: "Neither confirmed" };
const allScenarios: Scenario[] = ["UP_FIRST", "DOWN_FIRST", "NEITHER"];
const allPaths: Array<Scenario | TrajectoryKind> = ["BULL", "MIDDLE", "BEAR", ...allScenarios];
const pathNames: Record<TrajectoryKind, string> = { BULL: "Bull", MIDDLE: "Middle", BEAR: "Bear" };
/** One path to draw, with the label shown where it ends on the chart. */
export interface ForecastDrawPath { id: Scenario | TrajectoryKind; scenario?: Scenario; label: string; candles: StructuralBar[];
  /** The forecast an update replaced, drawn as a faint outline beneath the live one. */
  faded?: boolean }
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;
/**
 * Chart label: where the path ends and the break odds. The share of similar
 * setups that ended higher/lower is shown only when that share beat a coin
 * flip on this market's untested setups (forecast.directionEdge).
 */
export function trajectoryLabel(t: Trajectory, p: Triple | undefined, directionEdge = false): string {
  if (t.kind === "MIDDLE") return `Middle ${signed(t.endChange)} · median of ${t.analogs} similar setups`;
  const up = t.kind === "BULL";
  return `${pathNames[t.kind]} ${signed(t.endChange)} · ${directionEdge ? `${pct(t.share)} of ${t.analogs} ended ${up ? "higher" : "lower"}` : `${up ? "top" : "bottom"} of the range`}`
    + (p ? ` · ${up ? "up" : "down"}-break first ${pct(p[up ? 0 : 1])}` : "");
}
/** The short label drawn where a path ends on the chart, e.g. "Bull +0.10% · range top". */
export function trajectoryChartLabel(t: Trajectory, directionEdge = false, weights?: Triple): string {
  if (t.kind === "MIDDLE") return weights ? "Median" : `Middle ${signed(t.endChange)} · median`;
  const up = t.kind === "BULL";
  if (weights) return `${up ? "Up" : "Down"} first ${formatWeight(weights[up ? 0 : 1])}`;
  return `${pathNames[t.kind]} ${signed(t.endChange)} · ${directionEdge ? `${pct(t.share)} ${up ? "higher" : "lower"}` : `range ${up ? "top" : "bottom"}`}`;
}
/** Which engine drew the range on this market, why, and whether up/down has a tested edge. */
export function rangeSentence(f: StructuralForecast): string | null {
  const r = f.range;
  if (!r) return null;
  const share = (x: number | null) => x == null ? "—" : pct(x);
  const evidence = r.tested ? ` On ${r.tested} setups the model did not learn from, the history range held ${share(r.historyInside)} of outcomes and the volatility range ${share(r.volatilityInside)} (ideal 50%).` : "";
  const engine = r.engine === "HISTORY"
    ? "Range engine for this market: history — the 25th–75th percentile of similar past setups, because it scored reliably better than a volatility range here."
    : r.reason === "TOO_FEW_TEST_SETUPS"
      ? "Range engine for this market: volatility — too little tested history to judge the history engine yet."
      : `Range engine for this market: volatility — sized from ${r.volatility === "HOUR_OF_WEEK" ? "how much this market usually moves at these hours of the week and how active it has been today" : "recent price swings"}, because the history range did not score reliably better here.`;
  const direction = f.directionEdge
    ? " Up/down: the share of similar setups that ended higher beat a coin flip here, so it is shown."
    : " The analogs have no verified edge for whether the window ends higher or lower. First-break odds are scored separately.";
  return engine + evidence + direction;
}
/** What the forecast learned from earlier graded forecasts of this window. */
export function learningSentence(c: CalibrationRecord): string {
  if (c.applied) return `Learned from ${c.graded} independent graded forecasts${c.skippedOverlapping ? ` (${c.skippedOverlapping} overlapping not counted)` : ""}: percentages adjusted ${pct(c.weight)} toward how often each outcome happened, `
    + `kept because it scored ${c.holdoutGain!.toFixed(3)} Brier better on the ${c.heldOut} newest forecasts it did not learn from. Raw model: `
    + `${pct(c.raw[0])} / ${pct(c.raw[1])} / ${pct(c.raw[2])}.`;
  const why: Record<string, string> = { RAW_MODEL_SCORED_BEST: "the raw model already scored best", DID_NOT_IMPROVE_ON_HELD_OUT_FORECASTS: "the adjustment did not score better on forecasts it had not seen" };
  const skipped = c.skippedOverlapping ? ` (${c.skippedOverlapping} overlapping or updated forecasts not counted)` : "";
  if (c.graded < 30) return `Learning: ${c.graded} of 30 independent graded forecasts needed for this window before percentages can be adjusted${skipped}.`;
  return `Learning: ${c.graded} independent graded forecasts${skipped}; percentages left unchanged because ${why[c.reason] ?? c.reason.replaceAll("_", " ").toLowerCase()}.`;
}
const outcomeNames: Record<Scenario, string> = { UP_FIRST: "broke up first", DOWN_FIRST: "broke down first", NEITHER: "no break" };
function gradeLine(g: ForecastGrade, outcome: Scenario): string {
  return `${outcomeNames[outcome]}, gave it ${pct(g.probabilityOfOutcome)} · ended ${signed(g.actualEndChange)}`
    + (g.nearestPath ? ` · nearest ${pathNames[g.nearestPath].toLowerCase()} path` : "")
    + (g.priceScore ? ` · price estimate error ${g.priceScore.mae.toLocaleString(undefined, { maximumSignificantDigits: 4 })} pts vs flat ${g.priceScore.flatMae.toLocaleString(undefined, { maximumSignificantDigits: 4 })} pts over ${g.priceScore.matched} closes` : "")
    + (g.routeScore ? ` · favored scenario error ${g.routeScore.mae.toLocaleString(undefined, { maximumSignificantDigits: 4 })} pts vs flat ${g.routeScore.flatMae.toLocaleString(undefined, { maximumSignificantDigits: 4 })} pts over ${g.routeScore.matched} closes` : "")
    + (g.insideRange == null ? "" : g.insideRange ? " · inside bull–bear range" : " · outside bull–bear range");
}
export interface ForecastDirectionRead {
  symbol: string;
  timeframe: string;
  window: string;
  asOf: number;
  endsAt: number;
  weights: Triple;
  verdict: string;
  leadPoints: number;
  favoredBreak: "up" | "down" | null;
  basis: string;
  provider?: string;
  savedFallback?: boolean;
  route?: ForecastRoute;
  priceEstimate?: StructuralForecast["priceEstimate"];
  view?: "estimate" | "routes" | "range";
  favoriteScenario?: Scenario | null;
}

function validWeights(weights: Triple | null | undefined): weights is Triple {
  return !!weights && weights.length === 3 && weights.every(p => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(weights.reduce((sum, p) => sum + p, 0) - 1) <= 0.00001;
}

function directionBasis(f: StructuralForecast, bars: number, weights: Triple): string {
  if (f.calibration?.applied) return "Calibrated probabilities";
  if (f.baselineMass) {
    try {
      const historical = probabilities(f.baselineMass, bars);
      return weights.some((p, i) => Math.abs(p - historical[i]!) > 1e-10)
        ? "Chart-adjusted probabilities" : "Historical-frequency baseline";
    } catch {
      return "Forecast probabilities";
    }
  }
  return f.mode === "BASELINE" ? "Historical-frequency baseline" : "Model probabilities";
}

export function forecastDirectionRead(f: StructuralForecast): ForecastDirectionRead | null {
  const window = forecastHorizon(f.horizonId ?? DEFAULT_FORECAST_HORIZON);
  const weights = window && f.horizons.find(h => h.bars === window.bars)?.probabilities;
  if (!window || !validWeights(weights)) return null;
  const outcomes = ["Bullish break favored", "Bearish break favored", "No break favored"];
  const ranked = [0, 1, 2].sort((a, b) => weights[b]! - weights[a]!);
  const first = ranked[0]!, second = ranked[1]!;
  const leadPoints = 100 * (weights[first]! - weights[second]!);
  // A tie at the displayed precision must not be presented as a distinct lead.
  const favorite = favoredScenario(weights);
  const tied = favorite === null;
  return { symbol: f.origin.symbol, timeframe: window.timeframe, window: window.label, asOf: f.asOf,
    endsAt: f.asOf + window.bars * window.stepMs, weights, leadPoints,
    favoriteScenario: favorite, provider: f.origin.provider,
    favoredBreak: tied || first === 2 ? null : first === 0 ? "up" : "down",
    verdict: tied ? "No clear favorite" : outcomes[first]!,
    basis: directionBasis(f, window.bars, weights) };
}

const formatWeight = (p: number) => p > 0 && p < 0.0005 ? "<0.1%" : `${(100 * p).toFixed(1)}%`;

export function forecastHeadline(read: ForecastDirectionRead) {
  if (!read.favoriteScenario) return "No clear favorite";
  const index = allScenarios.indexOf(read.favoriteScenario);
  const label = ["Up first", "Down first", "No break"][index];
  return `${label} ${formatWeight(read.weights[index]!)}`;
}

export function ForecastDirectionSummary({ read }: { read: ForecastDirectionRead }) {
  const ended = Date.now() >= read.endsAt;
  return <div aria-label="Forecast directional weights" data-testid="forecast-direction" className="min-w-0 space-y-0.5 text-xs">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <strong>{read.verdict}</strong>{read.savedFallback && <span>Saved forecast · live update unavailable</span>}<span>{read.window} · {read.symbol} · {ended ? "Ended" : "Through"} {new Date(read.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
    </div>
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span>Up first <b>{formatWeight(read.weights[0])}</b></span>
      <span>Down first <b>{formatWeight(read.weights[1])}</b></span>
      <span>No break <b>{formatWeight(read.weights[2])}</b></span>
      <span className="text-muted-foreground">{read.verdict === "No clear favorite" ? "" : `${read.leadPoints.toFixed(1)} pt lead · `}{read.basis}</span>
    </div>
  </div>;
}

/** The facts the service sends with a refusal (ForecastFeedDiagnostics). */
export interface ForecastRefusalDetail { historySource?: string | null; historyBars?: number; chartSource?: string | null; chartQuality?: string; chartAiUsable?: boolean;
  closedBars?: number; barsBeforeLastGap?: number; lastCloseAgeSeconds?: number | null; timeframe?: string; trainingWindows?: number; trainingWindowsNeeded?: number;
  longestUnbrokenBars?: number; sessionsSeen?: number; trainingWindowsPossible?: number; historyBarLimit?: number }
const span = (bars: number, stepMs: number) => {
  const hours = bars * stepMs / 3_600_000;
  return hours >= 48 ? `${+(hours / 24).toFixed(1)} days` : hours >= 1 ? `${+hours.toFixed(1)} hours` : `${Math.round(hours * 60)} minutes`;
};
/**
 * What the panel says when the service declines a forecast. If the market's
 * sessions can never hold the window, it says so plainly, as permanent. Any
 * other refusal is shown by its code and what the feed looked like. A broken
 * recent history also says what clears it.
 */
export function forecastRefusalMessage(reason: string, d: ForecastRefusalDetail | undefined, preset: ForecastHorizonPreset): string {
  const tf = d?.timeframe ?? preset.timeframe;
  if (reason === "MARKET_SESSIONS_TOO_SHORT" && d?.longestUnbrokenBars != null) {
    const seen = `In ${d.sessionsSeen ?? 0} sessions, its longest unbroken run was ${d.longestUnbrokenBars} ${tf} bars (${span(d.longestUnbrokenBars, preset.stepMs)})`;
    const why = d.longestUnbrokenBars < FIT_WINDOW_BARS
      ? `each training window needs ${FIT_WINDOW_BARS} bars (${span(FIT_WINDOW_BARS, preset.stepMs)}) in a row`
      : `sessions that long fit at most ${d.trainingWindowsPossible ?? 0} of the ${d.trainingWindowsNeeded ?? MIN_FIT_WINDOWS} training windows the model needs in the ${(d.historyBarLimit ?? 5000).toLocaleString("en-US")} bars it keeps`;
    return `${preset.label} ahead can't be forecast on this market. ${seen}; ${why}. Waiting won't change this; a shorter window may fit`;
  }
  const facts = d ? ` (${tf} feed: ${d.chartSource ?? "no source"}, quality ${d.chartQuality ?? "unknown"}, ${d.chartAiUsable ? "analysis-usable" : "not analysis-usable"}; history: ${d.historySource ?? "no source"}, ${d.closedBars ?? 0} unbroken closed bars${d.barsBeforeLastGap ? `, ${d.barsBeforeLastGap} older bars behind a gap` : ""}${d.trainingWindows != null ? `; ${d.trainingWindows} of ${d.trainingWindowsNeeded} gap-free training windows` : ""}; last bar closed ${d.lastCloseAgeSeconds == null ? "at an unknown time" : `${d.lastCloseAgeSeconds}s ago`})` : "";
  const clears = reason === "RECENT_HISTORY_HAS_GAP" && d?.closedBars != null && d.closedBars < FORECAST_INPUT_BARS
    ? `; it can be forecast once ${FORECAST_INPUT_BARS - d.closedBars} more ${tf} bars close without a gap` : "";
  return `${reason.replaceAll("_", " ").toLowerCase()}${facts}${clears}`;
}

/** Pair only finalized provider candles at the forecast's exact timestamps. */
export function routeProgress(route: Pick<ForecastRoute, "candles">, actual: readonly { openTime: string; closeTime: string; close: number; isComplete: boolean; isForming: boolean; source: string }[], provider: string, now: number) {
  const closes = actual.filter(c => c.source === provider && c.isComplete && !c.isForming && Date.parse(c.closeTime) <= now)
    .map(c => ({ openTime: Date.parse(c.openTime), closeTime: Date.parse(c.closeTime), close: c.close }));
  const score = scoreClosePath(route, closes);
  return { matched: score?.matched ?? 0, mae: score?.mae ?? null, flatMae: score?.flatMae ?? null,
    next: route.candles.find(c => c.closeTime > now) };
}

const routeNames: Record<Scenario, string> = { UP_FIRST: "Up-break route", DOWN_FIRST: "Down-break route", NEITHER: "No-break route" };
function routePath(route: ForecastRoute, weights?: Triple, faded = false): ForecastDrawPath {
  return { id: route.scenario, scenario: route.scenario, label: faded ? "" : weights ? `${labels[route.scenario]} ${formatWeight(weights[allScenarios.indexOf(route.scenario)]!)}` : routeNames[route.scenario], candles: route.candles, faded };
}

const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function StructuralForecastPanel({ symbol, onPaths, onDirectionRead, selectedScenarios, onSelectedScenariosChange, chartTimeframe, onShowOnTimeframe }: { symbol: string; onPaths(paths: ForecastDrawPath[]): void; onDirectionRead?(read: ForecastDirectionRead | null): void; selectedScenarios?:Array<Scenario | TrajectoryKind>; onSelectedScenariosChange?:(next:Array<Scenario | TrajectoryKind>)=>void;
  /** The chart's candle length; paths are drawn only on a chart of their own length. */
  chartTimeframe?: string; onShowOnTimeframe?:(timeframe: string)=>void }) {
  const canonicalSymbol = resolveArxMarket(symbol)?.canonicalSymbol ?? symbol;
  const [row, setRow] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row[]>([]);
  const [internalSelected, setInternalSelected] = useState<Array<Scenario | TrajectoryKind>>(allPaths);
  const selected=selectedScenarios??internalSelected;
  const setSelected=(next:Array<Scenario | TrajectoryKind>)=>{setInternalSelected(next);onSelectedScenariosChange?.(next);};
  // One window drives the request, the shown probabilities and the scoring.
  const [horizonId, setHorizonId] = useState(DEFAULT_FORECAST_HORIZON);
  const preset = forecastHorizon(horizonId) ?? forecastHorizon(DEFAULT_FORECAST_HORIZON)!;
  const rowHorizonId = (r: Row) => r.forecast.horizonId ?? DEFAULT_FORECAST_HORIZON;
  const [cohort, setCohort] = useState("all");
  const [preferredView, setView] = useState<"estimate" | "routes" | "range">("estimate");
  const view = preferredView === "estimate" && !row?.forecast.priceEstimate ? "routes" : preferredView;
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Windows this market's sessions can never hold, with the reason, by window id.
  const [unavailable, setUnavailable] = useState<Record<string, string>>({});
  const unavailableReason = unavailable[preset.id];
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    request.current?.abort(); setRow(null); setHistory([]); setError(null); setAuto(false); setBusy(false); setUnavailable({});
    return () => { request.current?.abort(); };
  }, [symbol]);
  useEffect(() => {
    // Draw only the paths of the window being shown.
    const current = row && (row.forecast.horizonId ?? DEFAULT_FORECAST_HORIZON) === horizonId ? row : null;
    if (!current || current.forecast.origin.symbol !== canonicalSymbol) { onPaths([]); return; }
    const f = current.forecast;
    const weights = f.horizons.find(h => h.minutes === preset.minutes)?.probabilities;
    const originalForecast = f.update ? history.find(r => r.id === f.update!.of)?.forecast : undefined;
    if (f.priceEstimate && view === "estimate") {
      onPaths([{ id: "MIDDLE", label: f.priceEstimate.method === "FLAT" ? "Last-close estimate" : "Estimated close", candles: f.priceEstimate.candles }]);
      return;
    }
    if (f.routes && view === "routes") {
      onPaths([...(originalForecast?.routes ?? []).filter(r => selected.includes(r.scenario)).map(r => routePath(r, undefined, true)),
        ...f.routes.filter(r => selected.includes(r.scenario)).map(r => routePath(r, weights))]);
      return;
    }
    const original = originalForecast?.trajectories ?? [];
    onPaths(f.trajectories?.length
      ? [...original.filter(t => selected.includes(t.kind)).map(t => ({ id: t.kind, label: "", candles: t.candles, faded: true })),
        ...f.trajectories.filter(t => selected.includes(t.kind)).map(t => ({ id: t.kind, label: trajectoryChartLabel(t, f.directionEdge, weights), candles: t.candles }))]
      : f.paths.filter(path => selected.includes(path.scenario)).map(path => ({ id: path.scenario, scenario: path.scenario,
        label: `${labels[path.scenario]} ${pct(path.probability)}`, candles: path.candles })));
  }, [row, history, canonicalSymbol, selected, onPaths, horizonId, view, preset.minutes]);

  const shown = row && rowHorizonId(row) === preset.id && row.forecast.origin.symbol === canonicalSymbol ? row : null;
  useEffect(() => {
    const read = shown && forecastDirectionRead(shown.forecast);
    onDirectionRead?.(read ? { ...read, savedFallback: Boolean(error), route: shown?.forecast.routes?.find(r => r.scenario === read.favoriteScenario), priceEstimate: shown?.forecast.priceEstimate, view: shown?.forecast.routes ? view : "range" } : null);
  }, [shown, onDirectionRead, error, view]);

  const generate = useCallback(async (historyOnly = false, showOnChart = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    let latest: Row | undefined;
    try {
      // Resolve existing predictions separately, then issue/save the next one.
      const historyResponse = await fetch(`${basePath}/api/me/structural/forecasts?symbol=${encodeURIComponent(symbol)}`, { credentials: "include", signal: controller.signal });
      if (historyResponse.ok) {
        const memory = await historyResponse.json();
        if (!controller.signal.aborted) {
          const saved: Row[] = memory.forecasts ?? [];
          setHistory(saved);
          latest = saved.filter(r => rowHorizonId(r) === preset.id && r.forecast.origin.symbol === canonicalSymbol)
              .sort((a,b) => b.issuedAt - a.issuedAt)[0];
          if (historyOnly) setRow(latest ?? null);
        }
      } else if (historyOnly) throw new Error("prediction memory unavailable");
      if (historyOnly) return;
      const response = await fetch(`${basePath}/api/me/structural/forecasts`, { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, horizon: preset.id }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !result.saved) {
        // State what the forecast saw, not only that it declined.
        const reason = String(result.reason ?? result.error ?? "FORECAST_UNAVAILABLE");
        const message = forecastRefusalMessage(reason, result.detail as ForecastRefusalDetail | undefined, preset);
        if (reason === "MARKET_SESSIONS_TOO_SHORT") {
          // This market's sessions can never hold this window: stop offering it.
          if (!controller.signal.aborted) { setUnavailable(u => ({ ...u, [preset.id]: message })); setAuto(false); }
          return;
        }
        throw new Error(message);
      }
      if (!controller.signal.aborted) {
        setRow(result as Row);
        if (showOnChart && chartTimeframe && chartTimeframe !== preset.timeframe) onShowOnTimeframe?.(preset.timeframe);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message.replaceAll("_", " ") : "forecast unavailable");
        if (latest && !historyOnly) {
          setRow(latest);
          if (showOnChart && chartTimeframe !== preset.timeframe) onShowOnTimeframe?.(preset.timeframe);
        }
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [symbol, preset, canonicalSymbol, chartTimeframe, onShowOnTimeframe]);

  const dynamicRequest = useRef({ generate, busy });
  useEffect(() => { dynamicRequest.current = { generate, busy }; }, [generate, busy]);
  useEffect(() => {
    if (!auto) return;
    // A new forecast is possible once per closed bar of the window's length.
    const timer = setInterval(() => {
      const current = dynamicRequest.current;
      if (!document.hidden && !current.busy) void current.generate();
    }, preset.stepMs);
    return () => clearInterval(timer);
  }, [auto, symbol, preset.id, preset.stepMs]);

  const probability = shown?.forecast.horizons.find(h => h.minutes === preset.minutes)?.probabilities;
  const windowHistory = history.filter(r => rowHorizonId(r) === preset.id);
  const recent = shown && !windowHistory.some(r => r.id === shown.id) ? [shown, ...windowHistory] : windowHistory;
  const paperTickets = recent.filter(r => r.paperPublishedAt != null);
  const directionWindows = independentForecasts(recent.map(r => ({row:r,asOf:r.forecast.asOf,update:!!r.forecast.update})),preset.stepMs*preset.bars);
  const firstBreakGrades = directionWindows.flatMap(({row}) => {
    const p = row.forecast.horizons.find(h => h.minutes === preset.minutes)?.probabilities;
    const result = uniqueHorizonScores(row.scores, preset.bars)[0];
    if (!result || !validWeights(p)) return [];
    return [favoredScenario(p) === result.outcome];
  });
  const targets = paperTickets.filter(r => r.paperGrade?.state === "TARGET").length;
  const stops = paperTickets.filter(r => r.paperGrade?.state === "STOP").length;
  const skippedOrders = paperTickets.filter(r => r.paperGrade?.state === "SKIPPED").length;
  const unverifiedOrders = paperTickets.filter(r => r.paperGrade?.state === "UNVERIFIED").length;
  // Older saved forecasts can contain a calculated bracket without an issued ticket.
  const savedPlan = shown?.forecast.paperInstruction;
  const unpublishedPlan = savedPlan && savedPlan.action !== "HOLD" && shown?.paperPublishedAt == null;
  const paperInstruction = unpublishedPlan
    ? { action: "HOLD" as const, reason: "No paper order was issued for this forecast." }
    : savedPlan;
  const selectedPaperGrade = windowHistory.find(r => r.id === shown?.id)?.paperGrade ?? shown?.paperGrade;
  const evaluated = windowHistory.filter(r => cohort === "all" || (cohort === "prebreak" ? r.forecast.preBreakEligible : !r.forecast.preBreakEligible))
    .flatMap(r => uniqueHorizonScores(r.scores, preset.bars).map(score => {
      const weights = r.forecast.horizons.find(h => h.minutes === preset.minutes)?.probabilities;
      const valid = validWeights(weights);
      const favorite = valid ? favoredScenario(weights) : null;
      const calibrated = valid && r.forecast.calibration?.applied;
      const outcome = scenarioIndex(score.outcome);
      return { outcome: score.outcome, favorite, baselineBrier: score.baselineBrier,
        brier: score.shownBrier ?? (calibrated ? brier(weights, outcome) : score.brier),
        logLoss: calibrated ? logLoss(weights, outcome) : score.logLoss };
    }));
  // Each finished forecast's judgement on its whole window, newest first.
  const graded = windowHistory.flatMap(r => { const sc = r.scores.find(x => x.horizon === preset.bars && x.grade);
    return sc?.grade ? [{ id: r.id, issuedAt: r.issuedAt, grade: sc.grade, outcome: sc.outcome, update: r.forecast.update }] : []; }).sort((a, b) => b.issuedAt - a.issuedAt);
  const cohortSummary = (rows: typeof graded) => rows.length
    ? `${rows.length}, average skill ${(rows.reduce((s, g) => s + g.grade.skill, 0) / rows.length).toFixed(2)}` : "none yet";
  const rangeCoverage = forecastRangeCoverage(windowHistory, preset.id, Date.now());
  const inRange = graded.filter(g => g.grade.insideRange != null);
  const directional = evaluated.filter(r => r.favorite === "UP_FIRST" || r.favorite === "DOWN_FIRST");
  const correctDirection = directional.filter(r => r.favorite === r.outcome).length;
  const actualDirection = evaluated.filter(r => r.outcome !== "NEITHER").length;
  const average = (key: "brier" | "baselineBrier" | "logLoss") => evaluated.length
    ? (evaluated.reduce((sum, r) => sum + r[key], 0) / evaluated.length).toFixed(4) : "—";
  return <section aria-label="Structural forecasts" className="border-t border-zinc-800 px-4 py-3 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-zinc-100">ARX structural forecast</strong>
      <label>Window <select aria-label="Forecast window" data-testid="forecast-window" className="rounded bg-zinc-900 p-1" value={preset.id}
        onChange={e => { request.current?.abort(); setBusy(false); setHorizonId(e.target.value); setAuto(false); setError(null); }}>
        {FORECAST_HORIZONS.map(h => <option key={h.id} value={h.id}>{h.label}{unavailable[h.id] ? " · not on this market" : ""}</option>)}</select></label>
      <Button size="sm" variant="outline" disabled={busy || Boolean(unavailableReason)} onClick={() => void generate(false, true)}>{busy ? "Building forecast…" : `Forecast ${preset.label} ahead`}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void generate(true)}>Refresh saved forecasts</Button>
      <label className="flex items-center gap-1"><input type="checkbox" aria-label="Dynamic forecast" checked={auto} disabled={Boolean(unavailableReason)} onChange={e => { setAuto(e.target.checked); if (e.target.checked) void generate(false, true); }} /> Dynamic: re-forecast each {preset.timeframe} bar</label>
    </div>
    {unavailableReason ? <p role="alert" data-testid="forecast-window-unavailable" className="mt-2 text-amber-300">{unavailableReason}.</p>
      : error && <p role="alert" className="mt-2 text-amber-300">Live update unavailable. {error}.{shown && " Showing the saved forecast below."}</p>}
    {shown && shown.forecast.origin.symbol === canonicalSymbol && <>
      {shown.forecast.update && <p data-testid="forecast-update" className="mt-2 text-sky-200">
        Updated {shown.forecast.update.barsIntoWindow} {preset.timeframe} bar{shown.forecast.update.barsIntoWindow === 1 ? "" : "s"} into the forecast issued {new Date(shown.forecast.update.anchorAsOf).toLocaleTimeString()}; the faint dashed outline shows the original when its paths are available.
        Updates are graded separately and are not used to learn, because they repeat the open forecast with less time left.</p>}
      <p className="mt-2 text-zinc-400">Saved {new Date(shown.issuedAt).toLocaleString()} · Data through {new Date(shown.forecast.asOf).toLocaleString()} · {preset.timeframe} bars · {shown.forecast.mode.replaceAll("_", " ").toLowerCase()} · {shown.forecast.origin.provider}</p>
      <div aria-label="Selected horizon probabilities" className="my-2 flex flex-wrap gap-4"><span>Outcomes within {preset.label}:</span>
        {allScenarios.map((scenario, i) => <span key={scenario}>{labels[scenario]}: <strong>{((probability?.[i] ?? 0) * 100).toFixed(1)}%</strong></span>)}
      </div>
      {paperInstruction && <div aria-label={paperInstruction.action === "HOLD" ? "Forecast paper instruction" : "Issued Forecast paper order"} className="my-2">
        <strong>{unpublishedPlan ? "Paper order · None issued" : `Paper instruction at issue · ${paperInstruction.action}`}</strong>
        {paperInstruction.action !== "HOLD" && <span> · Reference {paperInstruction.reference.toLocaleString(undefined, {maximumSignificantDigits: 9})} · Stop {paperInstruction.stop.toLocaleString(undefined, {maximumSignificantDigits: 9})} · Target {paperInstruction.target.toLocaleString(undefined, {maximumSignificantDigits: 9})}</span>}
        {paperInstruction.action !== "HOLD" && paperInstruction.entryLimit != null && <div className="text-xs">
          First quote only · {paperInstruction.action === "BUY" ? "maximum buy ask" : "minimum sell bid"} {paperInstruction.entryLimit.toLocaleString(undefined, {maximumSignificantDigits: 9})}
          {paperInstruction.breakoutLevel != null && <> · {paperInstruction.action === "BUY" ? "bid must hold above" : "ask must hold below"} {paperInstruction.breakoutLevel.toLocaleString(undefined, {maximumSignificantDigits: 9})}</>}
        </div>}
        <div className="text-xs text-zinc-400">{paperInstruction.reason}</div>
        {shown.paperPublishedAt != null && selectedPaperGrade && <div>Ticket result · {({ STOP: "Stopped", TARGET: "Target reached", OPEN: "Open", SKIPPED: "Entry skipped", UNVERIFIED: "Quote coverage incomplete", PENDING: "Awaiting first quote" })[selectedPaperGrade.state]}</div>}
      </div>}
      {shown.forecast.routes && <label className="mt-2 inline-flex items-center gap-2">Chart view
        <select aria-label="Forecast chart view" className="rounded bg-zinc-900 p-1" value={view} onChange={e => setView(e.target.value === "estimate" ? "estimate" : e.target.value === "range" ? "range" : "routes")}>
          {shown.forecast.priceEstimate && <option value="estimate">Estimated closes</option>}
          <option value="routes">Conditional break routes</option><option value="range">Price range</option>
        </select></label>}
      {view === "estimate" ? null : shown.forecast.routes && view === "routes" ? <div aria-label="Forecast routes" className="my-2 flex flex-wrap gap-3">
        {shown.forecast.routes.map(r => <label key={r.scenario} className="flex items-center gap-1"><input type="checkbox"
          disabled={!r.candles.length} checked={Boolean(r.candles.length && selected.includes(r.scenario))}
          onChange={e => setSelected(e.target.checked ? [...selected, r.scenario] : selected.filter(s => s !== r.scenario))} />
          {routeNames[r.scenario]} · {r.matches} matches{!r.candles.length && " · too few for a route"}
        </label>)}</div> : shown.forecast.trajectories?.length ? <div aria-label="Projected paths" className="my-2 flex flex-wrap gap-4"><span>{preset.label} paths ({preset.timeframe} candles):</span>
        {shown.forecast.trajectories.map(t => <label key={t.kind} className="flex items-center gap-2">
          <input type="checkbox" checked={selected.includes(t.kind)}
            onChange={e => setSelected(e.target.checked ? [...selected, t.kind] : selected.filter(s => s !== t.kind))} />
          <span>{trajectoryLabel(t, probability, shown.forecast.directionEdge)}</span>
        </label>)}</div>
      : <div className="my-2 flex flex-wrap gap-4"><span>{preset.label} ghost paths ({preset.timeframe} candles):</span>{shown.forecast.paths.map(path => <label key={path.scenario} className="flex items-center gap-2">
        <input type="checkbox" checked={selected.includes(path.scenario)} disabled={!path.candles.length}
          onChange={e => setSelected(e.target.checked ? [...selected, path.scenario] : selected.filter(s => s !== path.scenario))} />
        <span>{labels[path.scenario]} ({(path.probability * 100).toFixed(1)}%){!path.candles.length && " · path unavailable"}</span>
      </label>)}</div>}
      {chartTimeframe && chartTimeframe !== preset.timeframe && <p role="status" data-testid="forecast-timeframe-mismatch" className="mb-2 flex flex-wrap items-center gap-2 text-sky-200">
        The {preset.label} paths are {preset.timeframe} candles and are not drawn on this {chartTimeframe} chart.
        {onShowOnTimeframe && <Button size="sm" variant="outline" onClick={() => onShowOnTimeframe(preset.timeframe)}>Show on {preset.timeframe}</Button>}
      </p>}
      <p className="text-amber-200">{view === "estimate" && shown.forecast.priceEstimate
        ? shown.forecast.priceEstimate.method === "FLAT"
          ? `Using the last close. Prior testing has not established a more accurate price path for this window.`
          : `Each point is the median close across similar historical setups, including all break outcomes. The estimate passed the flat-price comparison on ${shown.forecast.priceEstimate.tested} independent windows.`
        : shown.forecast.routes && view === "routes"
        ? "Each point estimates a candle close from similar historical setups with the specified first break. The issued route stays fixed as actual candles arrive."
        : shown.forecast.trajectories?.length
        ? `The paths are not price predictions: the shaded range from bull to bear is a nominal 50% endpoint interval; actual coverage can differ (see measured coverage below), and the middle line is the median of the ${shown.forecast.trajectories[0]!.analogs} most similar past setups of this market, rescaled to the current price. Break odds are the model's chance that structure breaks that way first${shown.forecast.calibration?.applied ? ", adjusted by what earlier graded forecasts showed (see below)" : ""}; their accuracy is not yet validated.`
        : "Ghost paths are illustrative scenarios, not price predictions: each is one past stretch of this market, rescaled to the current price, whose outcome matched that scenario. “Neither” means no confirmed structural break; prices can still move."}</p>
      {rangeSentence(shown.forecast) && <p data-testid="forecast-range-engine" className="mt-1 text-zinc-300">{rangeSentence(shown.forecast)}</p>}
      {shown.forecast.calibration && <p data-testid="forecast-learning" className="mt-1 text-zinc-300">{learningSentence(shown.forecast.calibration)}</p>}
      <p className="mt-1 text-zinc-400">Model {shown.forecast.version} · {shown.forecast.gateReason.replaceAll("_", " ").toLowerCase()} · Predictive performance not yet validated.</p>
    </>}
    {(row || history.length > 0) && <div aria-label="Forecast performance" className="mt-3 flex flex-wrap gap-4 text-zinc-300">
      <label>Scoring <select aria-label="Forecast scoring cohort" className="rounded bg-zinc-900 p-1" value={cohort} onChange={e => setCohort(e.target.value)}>
        <option value="all">All snapshots</option><option value="prebreak">Before first break</option><option value="confirmation">After precursor</option>
      </select></label>
      <span>{preset.label} resolved: {evaluated.length}</span><span>Brier: {average("brier")}</span><span>Frequency baseline: {average("baselineBrier")}</span><span>Log loss: {average("logLoss")}</span>
      <span>Direction precision: {directional.length ? `${(100 * correctDirection / directional.length).toFixed(1)}% (${directional.length})` : "—"}</span>
      <span>Direction recall: {actualDirection ? `${(100 * correctDirection / actualDirection).toFixed(1)}%` : "—"}</span>
      <span>Saved {preset.label} forecasts: {windowHistory.length + (shown && !windowHistory.some(r => r.id === shown.id) ? 1 : 0)}</span>
    </div>}
    {directionWindows.length > 0 && <p aria-label="Independent first-break accuracy" className="mt-2 text-zinc-300">
      First-break calls · {firstBreakGrades.length ? `${(100 * firstBreakGrades.filter(Boolean).length / firstBreakGrades.length).toFixed(1)}% correct (${firstBreakGrades.filter(Boolean).length} of ${firstBreakGrades.length} settled)` : "Awaiting a completed window"} · {directionWindows.length - firstBreakGrades.length} unresolved · independent {preset.label} windows, including neither
    </p>}
    {paperTickets.length > 0 && <p aria-label="Forecast paper ticket results" className="mt-2 text-zinc-300">
      Recent paper tickets · {targets + stops ? `${(100 * targets / (targets + stops)).toFixed(1)}% targets (${targets} of ${targets + stops} settled)` : "Awaiting a verified exit"} · {skippedOrders} skipped · {unverifiedOrders} with incomplete quotes · {paperTickets.length - targets - stops - skippedOrders - unverifiedOrders} open or pending
    </p>}
    {windowHistory.length > 0 && <p data-testid="forecast-range-coverage" className="mt-2 text-zinc-300">
      Range coverage: {rangeCoverage.coverage == null ? "awaiting completed original forecasts" : `${pct(rangeCoverage.coverage)} inside across ${rangeCoverage.n} non-overlapping completed windows (${rangeCoverage.outside} outside; nominal target 50%)`}.
      {" "}{rangeCoverage.excluded} updates, overlapping, unresolved or ungraded windows excluded. Descriptive history; this does not establish calibrated future coverage or trading edge.
    </p>}
    {graded.length > 0 && <div aria-label="Graded forecasts" data-testid="forecast-grades" className="mt-3 text-zinc-300">
      <p><strong className="text-zinc-100">Graded {preset.label} forecasts: {graded.length}</strong>
        {" · "}{(["A", "B", "C", "D", "F"] as const).map(l => `${l} ${graded.filter(g => g.grade.letter === l).length}`).join(" · ")}
        {" · "}average skill {(graded.reduce((s, g) => s + g.grade.skill, 0) / graded.length).toFixed(2)} (against always guessing the training period's odds: 0 = no better, above 0 = better; C = about the same)
        {inRange.length > 0 && ` · ended inside bull–bear range ${pct(inRange.filter(g => g.grade.insideRange).length / inRange.length)}`}</p>
      <p data-testid="forecast-grade-cohorts">Fresh forecasts: {cohortSummary(graded.filter(g => !g.update))} · Updates mid-window: {cohortSummary(graded.filter(g => g.update))} (less time left, so not comparable)</p>
      <ul className="mt-1 space-y-0.5 text-zinc-400">{graded.slice(0, 8).map(g => <li key={g.id}>
        <strong className="text-zinc-100">{g.grade.letter}</strong> {new Date(g.issuedAt).toLocaleString()}{g.update ? ` · update +${g.update.barsIntoWindow} bars` : ""} · {gradeLine(g.grade, g.outcome)}{g.grade.rederived ? " · re-graded against the baseline" : ""}</li>)}</ul>
    </div>}
    {windowHistory.length > 0 && <label className="mt-2 block text-zinc-400">Review a saved forecast <select aria-label="Saved forecast" className="ml-2 rounded bg-zinc-900 p-1" value={shown?.id ?? ""} onChange={e => setRow(windowHistory.find(r => r.id === e.target.value) ?? row)}>
      <option value="">Select issuance time</option>{shown && !windowHistory.some(r => r.id === shown.id) && <option value={shown.id}>Current forecast</option>}
      {windowHistory.map(r => <option key={r.id} value={r.id}>{new Date(r.issuedAt).toLocaleString()}</option>)}
    </select></label>}
  </section>;
}
