import { useCallback, useEffect, useRef, useState } from "react";
import { forecastRangeCoverage, uniqueHorizonScores, FORECAST_HORIZONS, DEFAULT_FORECAST_HORIZON, forecastHorizon, type ForecastScore, type StructuralBar, type StructuralForecast, type Scenario, type Trajectory, type TrajectoryKind, type Triple, type CalibrationRecord, type ForecastGrade } from "@workspace/domain/structural";
import { Button } from "@/components/ui/button";
import { resolveArxMarket } from "@workspace/domain/market";

interface Row { id: string; issuedAt: number; forecast: StructuralForecast; scores: ForecastScore[] }
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
export function trajectoryChartLabel(t: Trajectory, directionEdge = false): string {
  if (t.kind === "MIDDLE") return `Middle ${signed(t.endChange)} · median`;
  const up = t.kind === "BULL";
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
    : " Up/down: no tested edge here, so up and down are treated as equally likely and no “x% higher” is shown.";
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
    + (g.insideRange == null ? "" : g.insideRange ? " · inside bull–bear range" : " · outside bull–bear range");
}
const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function StructuralForecastPanel({ symbol, onPaths, selectedScenarios, onSelectedScenariosChange, chartTimeframe, onShowOnTimeframe }: { symbol: string; onPaths(paths: ForecastDrawPath[]): void; selectedScenarios?:Array<Scenario | TrajectoryKind>; onSelectedScenariosChange?:(next:Array<Scenario | TrajectoryKind>)=>void;
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
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    request.current?.abort(); setRow(null); setHistory([]); setError(null); setAuto(false); setBusy(false);
    return () => { request.current?.abort(); };
  }, [symbol]);
  useEffect(() => {
    // Draw only the paths of the window being shown.
    const current = row && (row.forecast.horizonId ?? DEFAULT_FORECAST_HORIZON) === horizonId ? row : null;
    if (!current || current.forecast.origin.symbol !== canonicalSymbol) { onPaths([]); return; }
    const f = current.forecast;
    const original = f.update ? [...history, row].find(r => r?.id === f.update!.of)?.forecast.trajectories ?? [] : [];
    onPaths(f.trajectories?.length
      ? [...original.filter(t => selected.includes(t.kind)).map(t => ({ id: t.kind, label: "", candles: t.candles, faded: true })),
        ...f.trajectories.filter(t => selected.includes(t.kind)).map(t => ({ id: t.kind, label: trajectoryChartLabel(t, f.directionEdge), candles: t.candles }))]
      : f.paths.filter(path => selected.includes(path.scenario)).map(path => ({ id: path.scenario, scenario: path.scenario,
        label: `${labels[path.scenario]} ${pct(path.probability)}`, candles: path.candles })));
  }, [row, history, canonicalSymbol, selected, onPaths, horizonId]);

  const generate = useCallback(async (historyOnly = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      // Resolve existing predictions separately, then issue/save the next one.
      const historyResponse = await fetch(`${basePath}/api/me/structural/forecasts?symbol=${encodeURIComponent(symbol)}`, { credentials: "include", signal: controller.signal });
      if (historyResponse.ok) {
        const memory = await historyResponse.json();
        if (!controller.signal.aborted) setHistory(memory.forecasts ?? []);
      } else if (historyOnly) throw new Error("prediction memory unavailable");
      if (historyOnly) return;
      const response = await fetch(`${basePath}/api/me/structural/forecasts`, { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, horizon: preset.id }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !result.saved) {
        // State what the forecast saw, not only that it declined.
        const d = result.detail as { historySource?: string | null; historyBars?: number; chartSource?: string | null; chartQuality?: string; chartAiUsable?: boolean; closedBars?: number; barsBeforeLastGap?: number; lastCloseAgeSeconds?: number | null; timeframe?: string; trainingWindows?: number; trainingWindowsNeeded?: number } | undefined;
        const facts = d ? ` (${d.timeframe ?? preset.timeframe} feed: ${d.chartSource ?? "no source"}, quality ${d.chartQuality ?? "unknown"}, ${d.chartAiUsable ? "analysis-usable" : "not analysis-usable"}; history: ${d.historySource ?? "no source"}, ${d.closedBars ?? 0} unbroken closed bars${d.barsBeforeLastGap ? `, ${d.barsBeforeLastGap} older bars behind a gap` : ""}${d.trainingWindows != null ? `; ${d.trainingWindows} of ${d.trainingWindowsNeeded} gap-free training windows` : ""}; last bar closed ${d.lastCloseAgeSeconds == null ? "at an unknown time" : `${d.lastCloseAgeSeconds}s ago`})` : "";
        throw new Error(`${String(result.reason ?? result.error ?? "FORECAST_UNAVAILABLE").replaceAll("_", " ").toLowerCase()}${facts}`);
      }
      if (!controller.signal.aborted) setRow(result as Row);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message.replaceAll("_", " ") : "forecast unavailable");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [symbol, preset.id]);

  useEffect(() => {
    if (!auto) return;
    // A new forecast is possible once per closed bar of the window's length.
    const timer = setInterval(() => { if (!document.hidden && !busy) void generate(); }, preset.stepMs);
    return () => clearInterval(timer);
  }, [auto, busy, generate, preset.stepMs]);

  const shown = row && rowHorizonId(row) === preset.id ? row : null;
  const probability = shown?.forecast.horizons.find(h => h.minutes === preset.minutes)?.probabilities;
  const windowHistory = history.filter(r => rowHorizonId(r) === preset.id);
  const evaluated = windowHistory.filter(r => cohort === "all" || (cohort === "prebreak" ? r.forecast.preBreakEligible : !r.forecast.preBreakEligible))
    .flatMap(r => uniqueHorizonScores(r.scores, preset.bars).map(score => ({ score,
      p: r.forecast.horizons.find(h => h.minutes === preset.minutes)?.probabilities })));
  const scores = evaluated.map(r => r.score);
  // Each finished forecast's judgement on its whole window, newest first.
  const graded = windowHistory.flatMap(r => { const sc = r.scores.find(x => x.horizon === preset.bars && x.grade);
    return sc?.grade ? [{ id: r.id, issuedAt: r.issuedAt, grade: sc.grade, outcome: sc.outcome, update: r.forecast.update }] : []; }).sort((a, b) => b.issuedAt - a.issuedAt);
  const cohortSummary = (rows: typeof graded) => rows.length
    ? `${rows.length}, average skill ${(rows.reduce((s, g) => s + g.grade.skill, 0) / rows.length).toFixed(2)}` : "none yet";
  const rangeCoverage = forecastRangeCoverage(windowHistory, preset.id, Date.now());
  const inRange = graded.filter(g => g.grade.insideRange != null);
  const directional = evaluated.filter(r => r.p && r.p.indexOf(Math.max(...r.p)) < 2);
  const correctDirection = directional.filter(r => (r.p!.indexOf(Math.max(...r.p!)) === 0 ? "UP_FIRST" : "DOWN_FIRST") === r.score.outcome).length;
  const actualDirection = evaluated.filter(r => r.score.outcome !== "NEITHER").length;
  const average = (key: "brier" | "baselineBrier" | "logLoss") => scores.length ? (scores.reduce((s, r) => s + r[key], 0) / scores.length).toFixed(4) : "—";
  return <section aria-label="Structural forecasts" className="border-t border-zinc-800 px-4 py-3 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-zinc-100">ARX structural forecast</strong>
      <label>Window <select aria-label="Forecast window" data-testid="forecast-window" className="rounded bg-zinc-900 p-1" value={preset.id}
        onChange={e => { setHorizonId(e.target.value); setAuto(false); setError(null); }}>
        {FORECAST_HORIZONS.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void generate()}>{busy ? "Building forecast…" : `Forecast ${preset.label} ahead`}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void generate(true)}>Refresh saved forecasts</Button>
      <label className="flex items-center gap-1"><input type="checkbox" aria-label="Dynamic forecast" checked={auto} onChange={e => { setAuto(e.target.checked); if (e.target.checked) void generate(); }} /> Dynamic: re-forecast each {preset.timeframe} bar</label>
    </div>
    {error && <p role="alert" className="mt-2 text-amber-300">Forecast unavailable: {error}. Saved forecasts remain unchanged.</p>}
    {shown && shown.forecast.origin.symbol === canonicalSymbol && <>
      {shown.forecast.update && <p data-testid="forecast-update" className="mt-2 text-sky-200">
        Updated {shown.forecast.update.barsIntoWindow} {preset.timeframe} bar{shown.forecast.update.barsIntoWindow === 1 ? "" : "s"} into the forecast issued {new Date(shown.forecast.update.anchorAsOf).toLocaleTimeString()}; that original is drawn as a faint dashed outline.
        Updates are graded separately and are not used to learn, because they repeat the open forecast with less time left.</p>}
      <p className="mt-2 text-zinc-400">Saved {new Date(shown.issuedAt).toLocaleString()} · Data through {new Date(shown.forecast.asOf).toLocaleString()} · {preset.timeframe} bars · {shown.forecast.mode.replaceAll("_", " ").toLowerCase()} · {shown.forecast.origin.provider}</p>
      <div aria-label="Selected horizon probabilities" className="my-2 flex flex-wrap gap-4"><span>Outcomes within {preset.label}:</span>
        {allScenarios.map((scenario, i) => <span key={scenario}>{labels[scenario]}: <strong>{((probability?.[i] ?? 0) * 100).toFixed(1)}%</strong></span>)}
      </div>
      {shown.forecast.trajectories?.length ? <div aria-label="Projected paths" className="my-2 flex flex-wrap gap-4"><span>{preset.label} paths ({preset.timeframe} candles):</span>
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
      <p className="text-amber-200">{shown.forecast.trajectories?.length
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
      <span>{preset.label} resolved: {scores.length}</span><span>Brier: {average("brier")}</span><span>Frequency baseline: {average("baselineBrier")}</span><span>Log loss: {average("logLoss")}</span>
      <span>Direction precision: {directional.length ? `${(100 * correctDirection / directional.length).toFixed(1)}% (${directional.length})` : "—"}</span>
      <span>Direction recall: {actualDirection ? `${(100 * correctDirection / actualDirection).toFixed(1)}%` : "—"}</span>
      <span>Saved {preset.label} forecasts: {windowHistory.length + (shown && !windowHistory.some(r => r.id === shown.id) ? 1 : 0)}</span>
    </div>}
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
