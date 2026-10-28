import { LineSeries, HistogramSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp, type LogicalRange, type LineSeriesPartialOptions, type HistogramSeriesPartialOptions } from "lightweight-charts";
import type { ChartEngineCandle } from "./types";
import { StudyCalculator, studyDefinition, studyLabel, type ChartStudy, type StudyPoint } from "./chartStudies";
import { ChartDrawingPrimitive } from "./chartDrawingPrimitive";
import { validateDrawings, validatePreferences, type ChartDrawing } from "./chartWorkspace";

type PriceSeries = ISeriesApi<"Candlestick" | "Bar" | "Line">;
interface StudyHandle { calculator: StudyCalculator; lines: ISeriesApi<"Line" | "Histogram">[]; rendered: StudyPoint[] }

/** Separate ownership for user studies/drawings. Clearing these never removes
 * execution overlays or server-detected structure. Auxiliary series never add
 * invented timestamps to the shared time scale. */
export class ChartAnalysisRenderer {
  private studies: StudyHandle[] = [];
  private studyKey = "";
  private drawings: ChartDrawing[] = [];
  private drawingPrimitive: ChartDrawingPrimitive | null = null;
  private selectedDrawing: string | null = null;
  private frame: number | null = null;
  private pending: { candles: ChartEngineCandle[]; from: number } | null = null;
  private displayWindow: { from: number; to: number } | null = null;
  private rendering = false;
  /** time, open, high, low, close of every bar the calculators consumed. */
  private inputs: number[] = [];
  private onViewport = () => {
    if (this.rendering || !this.studies.length) return;
    const window = this.nextWindow();
    if (window !== this.displayWindow) this.renderWindow(window);
  };
  constructor(private chart: IChartApi, private price: PriceSeries) {
    chart.timeScale().subscribeVisibleLogicalRangeChange(this.onViewport);
  }
  setStudies(configs: ChartStudy[], candles: ChartEngineCandle[]): void {
    const valid = validatePreferences({studies:configs}).studies;
    const key = JSON.stringify(valid);
    if (this.studyKey === key) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    // Appending, removing or editing studies keeps the series and calculators
    // of untouched studies. Anything that cannot reproduce a full rebuild
    // exactly (reorder, insertion before a kept study, unexpected panes or a
    // manually scaled oscillator pane) takes the full rebuild instead.
    if (!this.patchStudies(valid, key, candles, range)) this.rebuildStudies(valid, key, candles, range);
  }
  private rebuildStudies(valid: ChartStudy[], key: string, candles: ChartEngineCandle[], range: LogicalRange | null): void {
    this.cancelPending();
    this.clearStudies(); this.displayWindow = null; this.studyKey = key;
    let pane = 0;
    for (const config of valid) {
      const paneIndex = studyDefinition(config.kind).pane ? ++pane : 0;
      this.studies.push({calculator:new StudyCalculator(config),lines:this.addStudySeries(config, paneIndex),rendered:[]});
    }
    // Set proportions only after all panes exist; inserting a later pane must
    // not collapse the first oscillator to the library minimum height.
    this.chart.panes().forEach((p, i)=>p.setStretchFactor(i === 0 ? 3 : 1));
    this.refresh(candles, 0, true);
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
  }
  private addStudySeries(config: ChartStudy, paneIndex: number): ISeriesApi<"Line" | "Histogram">[] {
    const definition = studyDefinition(config.kind);
    return definition.channels.map((_, i) => {
      const spec = studySeriesOptions(config, i);
      const line: ISeriesApi<"Line" | "Histogram"> = spec.histogram
        ? this.chart.addSeries(HistogramSeries, spec.options, paneIndex)
        : this.chart.addSeries(LineSeries, spec.options, paneIndex);
      if (i === 0) for (const price of definition.levels ?? []) line.createPriceLine({price,color:"#71717a",lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:String(price)});
      return line;
    });
  }
  /** Reconciles the current studies with `valid` so that series, options,
   * panes, draw order and rendered data equal what rebuildStudies would leave.
   * Returns false, before changing anything, when that cannot be guaranteed. */
  private patchStudies(valid: ChartStudy[], key: string, candles: ChartEngineCandle[], range: LogicalRange | null): boolean {
    const previous = this.studies;
    if (!previous.length || !valid.length) return false;
    const index = new Map(previous.map((study, i) => [studyMatchKey(study.calculator.config, i), i]));
    if (index.size !== previous.length) return false;
    const reuse: (StudyHandle | undefined)[] = [];
    const seen = new Set<string>();
    let last = -1, added = false;
    for (const [i, config] of valid.entries()) {
      const match = studyMatchKey(config, i);
      if (seen.has(match)) return false;
      seen.add(match);
      const at = index.get(match);
      if (at === undefined) { added = true; reuse.push(undefined); continue; }
      // Kept studies must keep their order and precede every new study, or
      // the rebuild's pane numbering and draw order could not be reproduced.
      if (added || at <= last) return false;
      last = at; reuse.push(previous[at]);
    }
    if (last < 0) return false;
    const kept = new Set(reuse);
    // One pane per oscillator, in study order, holding only its own series.
    const panes = this.chart.panes();
    const oscillators = previous.filter(study => studyDefinition(study.calculator.config.kind).pane);
    if (panes.length !== oscillators.length + 1) return false;
    for (const [i, study] of oscillators.entries()) {
      if (!sameSeries(panes[i + 1]!.getSeries(), study.lines)) return false;
      // A rebuild recreates the pane, whose price scales start from the chart
      // options. A pane the user scaled by hand would be reset, so rebuild.
      if (kept.has(study) && !this.freshPaneScales(i + 1)) return false;
    }
    this.cancelPending();
    this.studyKey = key;
    const dirty = this.firstInputChange(candles);
    let exact = false;
    this.rendering = true;
    try {
      for (const study of [...previous].reverse()) if (!kept.has(study)) for (const line of study.lines) this.chart.removeSeries(line);
      let pane = 0;
      this.studies = valid.map((config, i) => {
        const paneIndex = studyDefinition(config.kind).pane ? ++pane : 0;
        const old = reuse[i];
        if (!old) return {calculator:new StudyCalculator(config),lines:this.addStudySeries(config, paneIndex),rendered:[]};
        if (JSON.stringify(old.calculator.config) === JSON.stringify(config)) return old;
        // Same kind: only colour and title can differ; the rest is per kind.
        old.lines.forEach((line, channel) => {
          const change = changedOptions(studySeriesOptions(old.calculator.config, channel).options, studySeriesOptions(config, channel).options);
          if (change) line.applyOptions(change);
        });
        return {calculator:new StudyCalculator(config),lines:old.lines,rendered:old.rendered};
      });
      exact = this.matchRebuildLayout();
    } finally { this.rendering = false; }
    if (!exact) { this.rebuildStudies(valid, key, candles, range); return true; }
    this.chart.panes().forEach((p, i)=>p.setStretchFactor(i === 0 ? 3 : 1));
    // Kept calculators continue from the first input that differs from what
    // they consumed; new calculators start at 0 (calculate clamps to them).
    for (const study of this.studies) study.calculator.calculate(candles, dirty, false);
    this.recordInputs(candles, dirty);
    // The window a rebuild would choose: it starts from displayWindow = null.
    const window = studyDisplayWindow(this.studies[0]!.calculator.points.length, this.chart.timeScale().getVisibleLogicalRange(), null);
    this.displayWindow = window;
    this.rendering = true;
    try {
      for (const study of this.studies) {
        const visible = study.calculator.points.slice(window.from, window.to);
        const unchanged = samePoints(study.rendered, visible);
        study.rendered = visible;
        if (!unchanged) study.lines.forEach((line, channel) => line.setData(visible.map(point => this.renderPoint(study, point, channel))));
      }
    } finally { this.rendering = false; }
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
    return true;
  }
  /** After a patch: the panes must be the rebuild's panes, and pane 0 must
   * draw the overlay studies last in study order, as freshly added series. */
  private matchRebuildLayout(): boolean {
    const panes = this.chart.panes();
    const oscillators = this.studies.filter(study => studyDefinition(study.calculator.config.kind).pane);
    if (panes.length !== oscillators.length + 1) return false;
    if (!oscillators.every((study, i) => sameSeries(panes[i + 1]!.getSeries(), study.lines))) return false;
    const overlays = this.studies.filter(study => !studyDefinition(study.calculator.config.kind).pane).flatMap(study => study.lines);
    const series = panes[0]!.getSeries();
    if (!sameSeries(series.slice(series.length - overlays.length), overlays)) {
      for (const line of overlays) line.setSeriesOrder(series.length - 1);
    }
    return true;
  }
  /** Perf caveat: in lightweight-charts 5, applyOptions on the default left or
   * right price scale of ANY pane also merges those options into the chart
   * options. The drawing freeze path (lightweightChartsAdapter freeze) sets
   * autoScale:false on pane 0 and restores pane 0's previous value, so a
   * hand-scaled pane 0 leaves autoScale:false in the chart options. Kept
   * oscillator panes created before that no longer match, so the next study
   * change takes the full rebuild. The rebuild creates its panes from the
   * merged options, so later changes patch again: the incremental saving is
   * lost once per such scale-option change, not for the session, and the
   * output is correct either way. */
  private freshPaneScales(pane: number): boolean {
    const options = this.chart.options();
    return sameValue(this.chart.priceScale("left", pane).options(), options.leftPriceScale) &&
      sameValue(this.chart.priceScale("right", pane).options(), options.rightPriceScale);
  }
  /** Every calculator has consumed exactly these bar inputs. */
  private recordInputs(candles: ChartEngineCandle[], from: number): void {
    const start = Math.max(0, Math.min(from, this.inputs.length / INPUT_STRIDE, candles.length));
    const inputs = this.inputs;
    inputs.length = candles.length * INPUT_STRIDE;
    for (let i = start, k = start * INPUT_STRIDE; i < candles.length; i++, k += INPUT_STRIDE) {
      const bar = candles[i]!;
      inputs[k] = bar.time; inputs[k + 1] = bar.open; inputs[k + 2] = bar.high; inputs[k + 3] = bar.low; inputs[k + 4] = bar.close;
    }
  }
  private firstInputChange(candles: ChartEngineCandle[]): number {
    const inputs = this.inputs, count = Math.min(inputs.length / INPUT_STRIDE, candles.length);
    for (let i = 0, k = 0; i < count; i++, k += INPUT_STRIDE) {
      const bar = candles[i]!;
      if (bar.time !== inputs[k] || bar.open !== inputs[k + 1] || bar.high !== inputs[k + 2] || bar.low !== inputs[k + 3] || bar.close !== inputs[k + 4]) return i;
    }
    return count;
  }
  /** Price writes can move the shared time axis several times in one JS task.
   * Render studies once against the final viewport, before that task can paint. */
  batchViewport(work: () => void): void {
    const previous = this.rendering;
    this.rendering = true;
    try { work(); } finally { this.rendering = previous; }
  }
  refresh(candles: ChartEngineCandle[], from: number, replace: boolean): void {
    // A stream revision may still be queued when a poll/seek arrives. Its
    // earliest dirty index must survive coalescing into this synchronous read.
    const dirtyFrom = Math.min(from, this.pending?.from ?? from);
    this.cancelPending();
    for (const study of this.studies) study.calculator.calculate(candles, dirtyFrom, false);
    if (this.studies.length) this.recordInputs(candles, dirtyFrom);
    const window = this.nextWindow();
    if (replace || !this.displayWindow || window.from !== this.displayWindow.from) { this.renderWindow(window); return; }
    this.displayWindow = window;
    this.rendering = true;
    try {
      for (const study of this.studies) {
        const next = study.calculator.points.slice(window.from, window.to);
        const previous = study.rendered;
        let same = 0;
        while (same < previous.length && same < next.length && sameStudyPoint(previous[same]!, next[same]!)) same++;
        // Only a small changed tail can use the series tail API. A moved buffer,
        // historical correction or large seek keeps the complete replacement.
        const removed = previous.length - same, added = next.length - same;
        study.lines.forEach((line, channel) => {
          if (!removed && !added) return;
          // LWC pop counts plotted values, not whitespace rows. Warmup/null
          // channels must replace their data so removed timestamps cannot linger
          // or cause pop to remove an earlier finite value instead.
          const finite = (point: StudyPoint | undefined) => point?.values[channel] != null && Number.isFinite(point.values[channel]);
          const finiteTail = finite(previous.at(-1)) && finite(next.at(-1)) &&
            previous.slice(same).every(finite) && next.slice(same).every(finite);
          if (removed > 32 || added > 32 || !finiteTail) {
            line.setData(next.map(point => this.renderPoint(study, point, channel)));
          } else if (removed === 1 && added > 0 && previous[same]!.time === next[same]!.time) {
            // Revising the last point uses update, preserving the shared axis.
            for (const point of next.slice(same)) line.update(this.renderPoint(study, point, channel));
          } else {
            if (removed) line.pop(removed);
            for (const point of next.slice(same)) line.update(this.renderPoint(study, point, channel));
          }
        });
        study.rendered = next;
      }
    } finally { this.rendering = false; }
  }
  private renderPoint(study: StudyHandle, point: StudyPoint, channel: number) {
    const value = point.values[channel];
    return value == null || !Number.isFinite(value) ? {time: point.time as UTCTimestamp} : {
      time: point.time as UTCTimestamp, value,
      ...(study.calculator.config.kind === "macd" && channel === 2 ? {color: value >= 0 ? "#10b981" : "#ef4444"} : {}),
    };
  }
  private nextWindow() {
    return studyDisplayWindow(this.studies[0]?.calculator.points.length ?? 0, this.chart.timeScale().getVisibleLogicalRange(), this.displayWindow);
  }
  /** Keep all calculated values for inspection/replay, but only ask the chart
   * library to rebuild visible study geometry plus a generous pan buffer. Its
   * line renderer otherwise rebuilds every historical point on each frame. */
  private renderWindow(window: { from: number; to: number }): void {
    this.displayWindow = window;
    this.rendering = true;
    try {
      for (const study of this.studies) {
        const visible = study.calculator.points.slice(window.from, window.to);
        study.rendered = visible;
        study.lines.forEach((line, channel) => line.setData(visible.map(point => this.renderPoint(study, point, channel))));
      }
    } finally { this.rendering = false; }
  }
  /** Streams may deliver many revisions before the browser can display one.
   * Preserve every new candle in canonical history, then recalculate/render the
   * changed suffix once per frame. Never run a study update for each pixel tick. */
  refreshLater(candles: ChartEngineCandle[], from: number): void {
    if (!this.studies.length) return;
    this.pending = { candles, from: Math.min(from, this.pending?.from ?? from) };
    if (this.frame == null) this.frame = requestAnimationFrame(() => this.flushPending());
  }
  flushPending(): void {
    const pending = this.pending;
    this.cancelPending();
    if (pending) this.refresh(pending.candles, pending.from, false);
  }
  private cancelPending(): void {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pending = null;
  }
  destroy(): void { this.cancelPending(); this.chart.timeScale().unsubscribeVisibleLogicalRangeChange?.(this.onViewport); }
  inspect(time: number): { label: string; color: string; values: { name: string; value: number | null }[] }[] {
    this.flushPending();
    return this.studies.map(({ calculator }) => {
      let lo = 0, hi = calculator.points.length - 1;
      let values: (number | null)[] = [];
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const point = calculator.points[mid]!;
        if (point.time === time) { values = point.values; break; }
        if (point.time < time) lo = mid + 1; else hi = mid - 1;
      }
      return {
        label: studyLabel(calculator.config), color: calculator.config.color,
        values: studyDefinition(calculator.config.kind).channels.map((name, index) => ({ name, value: values[index] ?? null })),
      };
    });
  }
  setDrawings(drawings: ChartDrawing[], candles: ChartEngineCandle[]): void {
    this.drawings = validateDrawings(drawings);
    this.refreshDrawings(candles);
  }
  refreshDrawings(candles: ChartEngineCandle[]): void {
    if (!this.drawingPrimitive && this.drawings.length) {
      this.drawingPrimitive = new ChartDrawingPrimitive();
      this.price.attachPrimitive(this.drawingPrimitive);
      this.drawingPrimitive.setSelection(this.selectedDrawing);
    }
    this.drawingPrimitive?.setData(this.drawings, candles);
  }
  selectDrawing(id: string | null): void { this.selectedDrawing = id; this.drawingPrimitive?.setSelection(id); }
  replacePriceSeries(price: PriceSeries, candles: ChartEngineCandle[]): void {
    if (this.drawingPrimitive) this.price.detachPrimitive(this.drawingPrimitive);
    this.price = price;
    if (this.drawingPrimitive) this.price.attachPrimitive(this.drawingPrimitive);
    this.refreshDrawings(candles);
  }
  private clearStudies(): void {
    // Empty oscillator panes are automatically removed by the library.
    for (const study of [...this.studies].reverse()) for (const line of study.lines) this.chart.removeSeries(line);
    this.studies = [];
  }
}

/** The main price series owns the complete time axis. Studies may safely render
 * a subset of those same timestamps; no resampling or fabricated points occur. */
export function studyDisplayWindow(count: number, visible: LogicalRange | null, current: { from: number; to: number } | null) {
  if (!visible || !count) return current?.from === 0 && current.to === count ? current : { from: 0, to: count };
  const from = Math.max(0, Math.min(count, Math.floor(visible.from)));
  const to = Math.max(from, Math.min(count, Math.ceil(visible.to) + 1));
  if (current && from >= current.from && (current.from === 0 || from - current.from >= 50) &&
      from - current.from <= 400) {
    if (current.to <= count && to <= current.to && (current.to === count || current.to - to >= 50)) return current;
    // Keep the left buffer stable while the revealed tail grows/shrinks. Moving
    // it on every single bar would rebuild every study's shared time-axis data.
    if (Math.abs(current.to - count) <= 32 && to <= count && count - to < 50) {
      return current.to === count ? current : {from: current.from, to: count};
    }
  }
  return { from: Math.max(0, from - 200), to: Math.min(count, to + 200) };
}

/** Series options exactly as a full rebuild creates them. */
function studySeriesOptions(config: ChartStudy, channel: number):
  { histogram: true; options: HistogramSeriesPartialOptions } | { histogram: false; options: LineSeriesPartialOptions } {
  const definition = studyDefinition(config.kind);
  if (config.kind === "macd" && channel === 2) {
    return {histogram:true,options:{color:config.color,priceLineVisible:false,lastValueVisible:false,title:"",priceFormat:{type:"price",precision:5,minMove:.00001}}};
  }
  const title = definition.pane ? `${config.kind.toUpperCase()} ${config.period} ${definition.channels[channel]}` : "";
  return {histogram:false,options:{color:channel === 1 && (config.kind === "macd" || config.kind === "stochastic") ? "#fbbf24" : config.color, lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,title,priceFormat:{type:"price",precision:config.kind === "rsi" ? 2 : 5,minMove:config.kind === "rsi" ? .01 : .00001}, ...(definition.range ? {autoscaleInfoProvider:() => ({priceRange:{minValue:definition.range![0],maxValue:definition.range![1]}})} : {})}};
}
/** Options that differ between two same-kind specs. Functions depend on the
 * kind only (autoscale range), so they never differ. */
function changedOptions(previous: object, next: object): LineSeriesPartialOptions | null {
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const change: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (typeof after[key] === "function" || sameValue(before[key], after[key])) continue;
    change[key] = after[key];
  }
  return Object.keys(change).length ? change as LineSeriesPartialOptions : null;
}
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  // A key holding undefined and a missing key configure the same thing.
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) if (!sameValue(left[key], right[key])) return false;
  return true;
}
/** Identity used to keep a study across edits: id and kind, or position and
 * kind for studies saved without an id. */
function studyMatchKey(config: ChartStudy, index: number): string {
  return config.id ? `id:${config.id}:${config.kind}` : `at:${index}:${config.kind}`;
}
function sameSeries(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
function samePoints(a: StudyPoint[], b: StudyPoint[]): boolean {
  return a.length === b.length && a.every((point, i) => sameStudyPoint(point, b[i]!));
}
const INPUT_STRIDE = 5;

function sameStudyPoint(a: StudyPoint, b: StudyPoint): boolean {
  return a === b || a.time === b.time && a.values.length === b.values.length &&
    a.values.every((value, index) => Object.is(value, b.values[index]));
}
