import { LineSeries, HistogramSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp, type LogicalRange } from "lightweight-charts";
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
    this.cancelPending();
    this.clearStudies(); this.displayWindow = null; this.studyKey = key;
    let pane = 0;
    for (const config of valid) {
      const definition = studyDefinition(config.kind);
      const oscillator = definition.pane;
      const paneIndex = oscillator ? ++pane : 0;
      const count = definition.channels.length;
      const lines = Array.from({length:count}, (_, i) => {
        const histogram = config.kind === "macd" && i === 2;
        const title = oscillator ? `${config.kind.toUpperCase()} ${config.period} ${definition.channels[i]}` : "";
        const line: ISeriesApi<"Line" | "Histogram"> = histogram
          ? this.chart.addSeries(HistogramSeries, {color:config.color,priceLineVisible:false,lastValueVisible:false,title:"",priceFormat:{type:"price",precision:5,minMove:.00001}}, paneIndex)
          : this.chart.addSeries(LineSeries, {color:i === 1 && (config.kind === "macd" || config.kind === "stochastic") ? "#fbbf24" : config.color, lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,title,priceFormat:{type:"price",precision:config.kind === "rsi" ? 2 : 5,minMove:config.kind === "rsi" ? .01 : .00001}, ...(definition.range ? {autoscaleInfoProvider:() => ({priceRange:{minValue:definition.range![0],maxValue:definition.range![1]}})} : {})}, paneIndex);
        if (i === 0) for (const price of definition.levels ?? []) line.createPriceLine({price,color:"#71717a",lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:String(price)});
        return line;
      });
      this.studies.push({calculator:new StudyCalculator(config),lines,rendered:[]});

    }
    // Set proportions only after all panes exist; inserting a later pane must
    // not collapse the first oscillator to the library minimum height.
    this.chart.panes().forEach((p, i)=>p.setStretchFactor(i === 0 ? 3 : 1));
    this.refresh(candles, 0, true);
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
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
    for (const study of this.studies) study.calculator.calculate(candles, dirtyFrom);
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

function sameStudyPoint(a: StudyPoint, b: StudyPoint): boolean {
  return a === b || a.time === b.time && a.values.length === b.values.length &&
    a.values.every((value, index) => Object.is(value, b.values[index]));
}
