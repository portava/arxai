import { LineSeries, HistogramSeries, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from "lightweight-charts";
import type { ChartEngineCandle } from "./types";
import { StudyCalculator, type ChartStudy } from "./chartStudies";
import { drawingSegments, validateDrawings, validatePreferences, type ChartDrawing } from "./chartWorkspace";

type PriceSeries = ISeriesApi<"Candlestick" | "Bar" | "Line">;
interface StudyHandle { calculator: StudyCalculator; lines: ISeriesApi<"Line" | "Histogram">[] }

/** Separate ownership for user studies/drawings. Clearing these never removes
 * execution overlays or server-detected structure. Auxiliary series never add
 * invented timestamps to the shared time scale. */
export class ChartAnalysisRenderer {
  private studies: StudyHandle[] = [];
  private studyKey = "";
  private drawings: ChartDrawing[] = [];
  private drawingLines: ISeriesApi<"Line">[] = [];
  private priceLines: IPriceLine[] = [];
  constructor(private chart: IChartApi, private price: PriceSeries) {}
  setStudies(configs: ChartStudy[], candles: ChartEngineCandle[]): void {
    const valid = validatePreferences({studies:configs}).studies;
    const key = JSON.stringify(valid);
    if (this.studyKey === key) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.clearStudies(); this.studyKey = key;
    let pane = 0;
    for (const config of valid) {
      const oscillator = config.kind === "rsi" || config.kind === "macd";
      const paneIndex = oscillator ? ++pane : 0;
      const count = config.kind === "bollinger" || config.kind === "macd" ? 3 : 1;
      const lines = Array.from({length:count}, (_, i) => {
        const histogram = config.kind === "macd" && i === 2;
        const suffix = config.kind === "bollinger" ? [" basis", " upper", " lower"][i] : config.kind === "macd" ? ["", " signal", " histogram"][i] : "";
        const title = oscillator ? `${config.kind.toUpperCase()} ${config.period}${suffix}` : "";
        const line: ISeriesApi<"Line" | "Histogram"> = histogram
          ? this.chart.addSeries(HistogramSeries, {color:config.color,priceLineVisible:false,lastValueVisible:false,title:"",priceFormat:{type:"price",precision:5,minMove:.00001}}, paneIndex)
          : this.chart.addSeries(LineSeries, {color:i === 1 && config.kind === "macd" ? "#fbbf24" : config.color, lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,title,priceFormat:{type:"price",precision:config.kind === "rsi" ? 2 : 5,minMove:config.kind === "rsi" ? .01 : .00001}, ...(config.kind === "rsi" ? {autoscaleInfoProvider:() => ({priceRange:{minValue:0,maxValue:100}})} : {})}, paneIndex);
        if (config.kind === "rsi") for (const price of [30,70]) line.createPriceLine({price,color:"#71717a",lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:String(price)});
        return line;
      });
      this.studies.push({calculator:new StudyCalculator(config),lines});

    }
    // Set proportions only after all panes exist; inserting a later pane must
    // not collapse the first oscillator to the library minimum height.
    this.chart.panes().forEach((p, i)=>p.setStretchFactor(i === 0 ? 3 : 1));
    this.refresh(candles, 0, true);
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
  }
  refresh(candles: ChartEngineCandle[], from: number, replace: boolean): void {
    for (const study of this.studies) {
      const points = study.calculator.calculate(candles, replace ? 0 : from);
      study.lines.forEach((line, channel) => {
        const data = points.map(p => (p.values[channel] == null || !Number.isFinite(p.values[channel])) ? {time:p.time as UTCTimestamp} : {
          time:p.time as UTCTimestamp, value:p.values[channel]!,
          ...(study.calculator.config.kind === "macd" && channel === 2 ? {color:p.values[channel]! >= 0 ? "#10b981" : "#ef4444"} : {}),
        });
        if (replace) line.setData(data);
        else for (const point of data) line.update(point);
      });
    }
  }
  setDrawings(drawings: ChartDrawing[], candles: ChartEngineCandle[]): void {
    this.drawings = validateDrawings(drawings);
    this.refreshDrawings(candles);
  }
  refreshDrawings(candles: ChartEngineCandle[]): void {
    this.clearDrawings();
    if (!candles.length) return;
    const times = new Set(candles.map(c=>c.time));
    for (const d of this.drawings) {
      if (d.kind === "horizontal") {
        this.priceLines.push(this.price.createPriceLine({price:d.start.price,color:d.color,lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:"Drawing"}));
        continue;
      }
      // Preserve stored anchors while outside loaded history, but don't extend
      // the chart's timeline with drawing-only dates or distort candle spacing.
      if (!times.has(d.start.time) || !d.end || !times.has(d.end.time)) continue;
      for (const segment of drawingSegments(d)) {
        const line = this.chart.addSeries(LineSeries, {color:d.color,lineWidth:1,lineStyle:d.kind === "fibonacci" ? LineStyle.Dashed : LineStyle.Solid,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null,title:d.kind === "fibonacci" ? segment.label.replace("Fib ", "") : "Trend"});
        line.setData([segment.start,segment.end].sort((a,b)=>a.time-b.time).map(p=>({time:p.time as UTCTimestamp,value:p.price})));
        this.drawingLines.push(line);
      }
    }
  }
  replacePriceSeries(price: PriceSeries, candles: ChartEngineCandle[]): void {
    this.clearDrawings(); this.price = price; this.refreshDrawings(candles);
  }
  private clearDrawings(): void {
    for (const line of this.drawingLines) this.chart.removeSeries(line);
    for (const line of this.priceLines) this.price.removePriceLine(line);
    this.drawingLines = []; this.priceLines = [];
  }
  private clearStudies(): void {
    // Empty oscillator panes are automatically removed by the library.
    for (const study of [...this.studies].reverse()) for (const line of study.lines) this.chart.removeSeries(line);
    this.studies = [];
  }
}
