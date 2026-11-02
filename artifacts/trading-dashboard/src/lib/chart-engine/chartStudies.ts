import { calculateVolumeProfile, type VolumeProfileRange, type VolumeProfileResult } from "./chartVolumeProfile";
import {formatSourceChartTime} from "./chartClockEvidence";
import { advanceStudyAverage, chartTrueRange, type SeededAverageState } from "@workspace/domain/chart-indicator-math";
import { observedTickVolume, observedTradeVolume } from "./chartVolume";
import type { ChartEngineCandle } from "./types";
import { ChartRangeWindow, scanChartRange } from "./chartRangeWindow";

export type StudyKind =
  | "volume_profile" | "vwap" | "trade_volume" | "tick_volume" | "sma" | "ema" | "smma" | "wma" | "dema" | "tema" | "bollinger"
  | "rsi" | "macd" | "atr" | "cci" | "stochastic" | "williams"
  | "stddev" | "envelopes" | "momentum" | "roc" | "donchian" | "dmi";
export type AppliedPrice = "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "hlcc4" | "ohlc4";
export type AverageMethod = "sma" | "ema" | "smma" | "wma";
export interface StudyLineStyle { color?: string; width?: 1 | 2 | 3; style?: "solid" | "dashed" | "dotted"; visible?: boolean }
export interface VwapAnchor { kind:"observed_bar"; time:number; seriesIdentity:string }
export interface ChartStudy {
  /** Exact local study instance/channel, never a replacement OHLC series. */
  studySource?: { studyId: string; channel: number };
  /** Frozen exact observed-bar anchor; source changes must not borrow it. */
  vwapAnchor?: VwapAnchor;
  profileRange?: VolumeProfileRange;
  profileRows?: number;
  profileValueAreaPercent?: number;
  /** Old workspaces used kind as identity. Explicit IDs allow repeated studies. */
  id?: string;
  kind: StudyKind;
  period: number;
  color: string;
  source?: AppliedPrice;
  multiplier?: number;
  slow?: number;
  signal?: number;
  signalMethod?: "sma" | "ema";
  method?: AverageMethod;
  smoothing?: number;
  lineStyles?: StudyLineStyle[];
}
export interface StudyPoint { time: number; values: (number | null)[]; reason?:string }
export interface StudyDefinition {
  name: string;
  group: "Trend" | "Momentum" | "Volatility" | "Volume";
  description: string;
  defaults: ChartStudy;
  channels: string[];
  pane: boolean;
  appliedPrice: boolean;
  levels?: number[];
  range?: [number, number];
}

export const STUDY_CATALOG: StudyDefinition[] = [
  { name: "Simple moving average", group: "Trend", description: "Equal weight over the selected period.", defaults: { kind: "sma", period: 20, color: "#fbbf24" }, channels: ["SMA"], pane: false, appliedPrice: true },
  { name: "Exponential moving average", group: "Trend", description: "Recent prices carry more weight; seeded with an SMA.", defaults: { kind: "ema", period: 50, color: "#38bdf8" }, channels: ["EMA"], pane: false, appliedPrice: true },
  { name: "Bollinger Bands", group: "Volatility", description: "SMA basis with population standard deviation bands.", defaults: { kind: "bollinger", period: 20, multiplier: 2, color: "#a78bfa" }, channels: ["Basis", "Upper", "Lower"], pane: false, appliedPrice: true },
  { name: "Relative strength index", group: "Momentum", description: "Wilder smoothing of gains and losses; flat markets read 50.", defaults: { kind: "rsi", period: 14, color: "#e879f9" }, channels: ["RSI"], pane: true, appliedPrice: true, levels: [30, 70], range: [0, 100] },
  { name: "MACD", group: "Momentum", description: "Fast minus slow EMA. Choose EMA or MT5-style SMA signal smoothing.", defaults: { kind: "macd", period: 12, slow: 26, signal: 9, color: "#2dd4bf" }, channels: ["MACD", "Signal", "Histogram"], pane: true, appliedPrice: true, levels: [0] },
  { name: "Smoothed moving average", group: "Trend", description: "Wilder / RMA smoothing with weight 1 ÷ period.", defaults: { kind: "smma", period: 20, color: "#fb923c" }, channels: ["SMMA"], pane: false, appliedPrice: true },
  { name: "Weighted moving average", group: "Trend", description: "Linear weights; the newest bar has the largest weight.", defaults: { kind: "wma", period: 20, color: "#4ade80" }, channels: ["WMA"], pane: false, appliedPrice: true },
  { name: "Double exponential moving average", group: "Trend", description: "2 × EMA minus EMA of EMA; each stage warms up separately.", defaults: { kind: "dema", period: 20, color: "#f472b6" }, channels: ["DEMA"], pane: false, appliedPrice: true },
  { name: "Triple exponential moving average", group: "Trend", description: "3 × EMA − 3 × EMA² + EMA³; three seeded stages.", defaults: { kind: "tema", period: 20, color: "#818cf8" }, channels: ["TEMA"], pane: false, appliedPrice: true },
  { name: "Average true range", group: "Volatility", description: "Range including gaps from the previous close. Select smoothing.", defaults: { kind: "atr", period: 14, method: "smma", color: "#fb923c" }, channels: ["ATR"], pane: true, appliedPrice: false },
  { name: "Commodity channel index", group: "Momentum", description: "Distance from the mean divided by 0.015 × mean absolute deviation.", defaults: { kind: "cci", period: 20, source: "hlc3", color: "#38bdf8" }, channels: ["CCI"], pane: true, appliedPrice: true, levels: [-100, 0, 100] },
  { name: "Stochastic oscillator", group: "Momentum", description: "SMA-smoothed %K in the high/low range, followed by an SMA %D.", defaults: { kind: "stochastic", period: 14, smoothing: 3, signal: 3, color: "#2dd4bf" }, channels: ["%K", "%D"], pane: true, appliedPrice: false, levels: [20, 80], range: [0, 100] },
  { name: "Williams percent range", group: "Momentum", description: "Close within the lookback high/low range, from −100 to 0.", defaults: { kind: "williams", period: 14, color: "#fbbf24" }, channels: ["%R"], pane: true, appliedPrice: false, levels: [-80, -20], range: [-100, 0] },
  { name: "Standard deviation", group: "Volatility", description: "Population deviation around the selected price's simple mean.", defaults: { kind: "stddev", period: 20, color: "#a78bfa" }, channels: ["Deviation"], pane: true, appliedPrice: true },
  { name: "Moving average envelopes", group: "Trend", description: "Percentage bands above and below a configurable moving average.", defaults: { kind: "envelopes", period: 20, multiplier: 1, method: "sma", color: "#f472b6" }, channels: ["Basis", "Upper", "Lower"], pane: false, appliedPrice: true },
  { name: "Momentum ratio", group: "Momentum", description: "Current price ÷ price N bars ago × 100 (MT5 convention).", defaults: { kind: "momentum", period: 14, color: "#4ade80" }, channels: ["Momentum"], pane: true, appliedPrice: true, levels: [100] },
  { name: "Rate of change", group: "Momentum", description: "Percentage price change over N bars.", defaults: { kind: "roc", period: 14, color: "#fbbf24" }, channels: ["ROC %"], pane: true, appliedPrice: true, levels: [0] },
  { name: "Donchian Channels", group: "Volatility", description: "Highest high, lowest low and their midpoint over the selected bars, including the forming bar. Requires a full window; channel contact alone is not a breakout signal.", defaults: { kind: "donchian", period: 20, color: "#38bdf8" }, channels: ["Midpoint", "Upper", "Lower"], pane: false, appliedPrice: false },
  { name: "Directional movement (DMI / ADX)", group: "Trend", description: "Wilder-smoothed +DI and −DI show directional movement; ADX measures strength, not direction or confidence. Separate DI and ADX lengths; tied moves count as zero. Not a trade signal.", defaults: { kind: "dmi", period: 14, signal: 14, color: "#38bdf8" }, channels: ["+DI", "−DI", "ADX"], pane: true, appliedPrice: false, range: [0, 100] },
  { name: "Tick volume", group: "Volume", description: "Explicit MT5 per-bar tick counts, not traded size. Only source-qualified observations are plotted; missing or partial streaming evidence stays blank, never zero-filled. No real traded-volume data is inferred.", defaults: { kind: "tick_volume", period: 1, color: "#38bdf8" }, channels: ["Ticks"], pane: true, appliedPrice: false },
  { name:"Anchored VWAP",group:"Volume",description:"Cumulative original bar price × provider-reported trade units / cumulative trade units, from an exact observed bar. HLC3 by default. Loaded observations only, not a full session or trade-by-trade average. Missing/zero/unqualified volume holds the remaining interval; no tick proxy.",defaults:{kind:"vwap",period:1,source:"hlc3",color:"#fbbf24"},channels:["VWAP"],pane:false,appliedPrice:true },
  { name:"Trade volume",group:"Volume",description:"Qualified provider-reported trade units per original closed bar. These are not tick counts, proven shares or consolidated-market volume. Missing/zero/unqualified quantities stay blank.",defaults:{kind:"trade_volume",period:1,color:"#34d399"},channels:["Trade units"],pane:true,appliedPrice:false },
  {name:"Estimated volume profile",group:"Volume",description:"Fixed-range price bins estimate uniform volume across original candle ranges. Qualified provider trade units only; no tick substitute, observed executions-at-price or complete-session claim.",defaults:{kind:"volume_profile",period:1,color:"#a78bfa",profileRows:32,profileValueAreaPercent:70},channels:["Estimated trade units"],pane:false,appliedPrice:false},
];
/** Preserve the original starter collection and saved templates. */
export const STUDY_DEFAULTS = (["sma", "ema", "bollinger", "rsi", "macd"] as const).map(kind => STUDY_CATALOG.find(item => item.defaults.kind === kind)!.defaults);
export const MAX_STUDIES = 12;
export const studyDefinition = (kind: StudyKind) => STUDY_CATALOG.find(item => item.defaults.kind === kind)!;
export const studyId = (study: ChartStudy) => study.id ?? study.kind;
/** Only scalar-input formulas can consume another study. OHLC/volume formulas cannot. */
export function acceptsStudySource(kind:StudyKind):boolean { return studyDefinition(kind).appliedPrice && kind !== "vwap"; }
export function studySourceIssue(config:ChartStudy,configs:readonly ChartStudy[]):string|null {
  const byId=new Map(configs.map(s=>[studyId(s),s]));
  const seen=new Set<string>();
  let current=config;
  while(current.studySource){
    if(seen.has(studyId(current)))return "Linked study is unavailable: circular source dependency.";
    seen.add(studyId(current));
    const ref=current.studySource,parent=byId.get(ref.studyId);
    if(!acceptsStudySource(current.kind)||!parent||parent.kind==='volume_profile'||!Number.isInteger(ref.channel)||ref.channel<0||ref.channel>=studyDefinition(parent.kind).channels.length)
      return "Linked study is unavailable: its source study or channel is missing or unsupported.";
    current=parent;
  }
  return null;
}
export function studyChannelColor(config: ChartStudy, channel: number): string {
  return config.lineStyles?.[channel]?.color ?? (config.kind === "dmi" ? (channel === 0 ? "#4ade80" : channel === 1 ? "#fb7185" : config.color) : channel === 1 && (config.kind === "macd" || config.kind === "stochastic") ? "#fbbf24" : config.color);
}
/** Match the existing legend precision for continuous values; observed integer
 * counts must remain exact (no 8-significant-digit rounding of large counts). */
export function formatStudyNumber(value:number,channel:string):string {
  return ["Ticks","Ticks (hidden)","Trade units","Trade units (hidden)","Frozen-range total trade units","Frozen-range total trade units (hidden)"].includes(channel) ? String(value) : String(Number(value.toPrecision(8)));
}
export function studyLabel(study: ChartStudy, studies?:readonly ChartStudy[]): string {
  if(study.kind === "volume_profile")return "Estimated volume profile · provider trade units";
  if(study.kind === "trade_volume")return "Trade volume · provider-reported trade units";
  if(study.kind === "vwap")return `VWAP · ${study.source ?? "hlc3"} · observed-bar anchor ${study.vwapAnchor ? formatSourceChartTime(study.vwapAnchor.time,false,"UTC",{seconds:true}) : "not selected"}`;
  if (study.kind === "tick_volume") return "Tick volume · ticks (not traded size)";
  const parameters = [study.period];
  if (study.kind === "macd") parameters.push(study.slow ?? 26, study.signal ?? 9);
  if (study.kind === "dmi") parameters.push(study.signal ?? 14);
  if (study.kind === "stochastic") parameters.push(study.smoothing ?? 3, study.signal ?? 3);
  if (study.kind === "bollinger" || study.kind === "envelopes") parameters.push(study.multiplier ?? 2);
  const parent=studies?.find(s=>studyId(s)===study.studySource?.studyId);
  const source = study.studySource ? ` · ${parent ? `${parent.kind.toUpperCase()} ${studies!.indexOf(parent)+1} / ${studyDefinition(parent.kind).channels[study.studySource.channel]??'unavailable output'}` : `linked study output ${study.studySource.channel + 1}`}` : studyDefinition(study.kind).appliedPrice ? ` · ${study.source ?? (study.kind === "cci" ? "hlc3" : "close")}` : "";
  const method = study.kind === "macd" ? ` · ${(study.signalMethod ?? "ema").toUpperCase()} signal`
    : study.kind === "atr" || study.kind === "envelopes" ? ` · ${(study.method ?? (study.kind === "atr" ? "smma" : "sma")).toUpperCase()}` : "";
  return `${study.kind.toUpperCase()} (${parameters.join(", ")})${source}${method}`;
}
export function appliedPrice(bar: ChartEngineCandle, source: AppliedPrice = "close"): number {
  switch (source) {
    case "hl2": return (bar.high + bar.low) / 2;
    case "hlc3": return (bar.high + bar.low + bar.close) / 3;
    case "hlcc4": return (bar.high + bar.low + 2 * bar.close) / 4;
    case "ohlc4": return (bar.open + bar.high + bar.low + bar.close) / 4;
    default: return bar[source];
  }
}

type AverageState = SeededAverageState;
interface State { price: number | null; run: number; averages: Record<string, AverageState>; vwap?:{numerator:number;denominator:number;reason?:string} }

/** One checkpoint per bar. A revised forming bar replaces its checkpoint;
 * appends never compound a previous revision, and replay never reads the future.
 * Rolling means, weighted means and recursive smoothing are O(1) per update.
 * Deviation/high-low windows are bounded by the validated period (max 1,000).
 * See docs/SMART_CHART_STUDY_CONVENTIONS.md for seeds and flat-market choices. */
export class StudyCalculator {
  private states: State[] = [];
  private profile:VolumeProfileResult|undefined;
  get profileResult():VolumeProfileResult|undefined{return this.profile;}
  /** prices[i] === states[i].price for every i < states.length. The O(n*p)
   * deviation loops read this contiguous buffer instead of State objects.
   * It persists across calls: entries at index >= states.length are stale and
   * never read, because the loops only read j < i. */
  private prices = new Float64Array(0);
  readonly points: StudyPoint[] = [];
  constructor(private currentConfig: ChartStudy) {}
  get config(): ChartStudy { return this.currentConfig; }
  /** Preserve checkpoints only when every calculation input is unchanged. */
  updatePresentation(next: ChartStudy): boolean {
    const inputs = ({color: _color, id: _id, lineStyles: _styles, ...rest}: ChartStudy) => JSON.stringify(rest);
    if (inputs(next) !== inputs(this.currentConfig)) return false;
    this.currentConfig = next;
    return true;
  }

  /** Rendering reads points directly and can omit the duplicate changed list.
   * Default callers still receive every changed point in its original order. */
  calculate(bars: ChartEngineCandle[], from = 0, collectChanges = true, input?: {points:readonly {time:number;values:readonly (number|null)[]}[];channel:number;reason?:string}): StudyPoint[] {
    const c = this.config;
    if(c.kind === "volume_profile") {
      this.profile=calculateVolumeProfile(bars,c.profileRange,c.profileRows??32,c.profileValueAreaPercent??70);
      this.points.length=0;this.states.length=0;return [];
    }
    const p = c.period;
    from = Math.max(0, Math.min(from, this.states.length, bars.length));
    this.states.length = from;
    this.points.length = from;
    if (this.prices.length < bars.length) {
      // Double on overflow and copy only the still-valid prefix; incremental
      // refreshes never copy the whole series.
      const grown = new Float64Array(Math.max(bars.length, this.prices.length * 2));
      grown.set(this.prices.subarray(0, from));
      this.prices = grown;
    }
    const prices = this.prices;
    const changed: StudyPoint[] = [];
    // Tiny revisions use the bounded direct scan: building four ring buffers
    // costs more than scanning one/two windows. An incomplete warm-up has no
    // range values at all. Bulk history remains linear in the number of bars.
    const usesRange = bars.length >= p && bars.length - from > 2 &&
      (c.kind === "stochastic" || c.kind === "williams" || c.kind === "donchian");
    const highs = usesRange ? new ChartRangeWindow(p, true) : null;
    const lows = usesRange ? new ChartRangeWindow(p, false) : null;
    // Only preceding observations enter the rebuilt window. Never inspect a
    // future bar when revising a tip or appending a replay prefix.
    if (highs && lows && from < bars.length) {
      for (let j = Math.max(0, from - p + 1); j < from; j++) {
        highs.push(bars[j]!.high, j); lows.push(bars[j]!.low, j);
      }
    }
    let i = from;
    let state: State;
    let previous: State | undefined;
    const average = (key: string, input: number | null, period: number, method: AverageMethod): number | null => {
      const prior = previous?.averages[key];
      const expired = this.states[i - period]?.averages[key]?.input ?? 0;
      const next = advanceStudyAverage(input, period, method, prior, expired);
      state.averages[key] = next;
      return next.value;
    };
    for (i = from; i < bars.length; i++) {
      const bar = bars[i]!;
      const supplied=input?.points[i];
      const candidate=c.studySource ? (acceptsStudySource(c.kind) && !input?.reason && supplied?.time===bar.time ? supplied.values[input!.channel] : null) : appliedPrice(bar, c.source ?? (c.kind === "cci" || c.kind === "vwap" ? "hlc3" : "close"));
      const price=typeof candidate==='number'&&Number.isFinite(candidate)?candidate:null;
      prices[i] = price ?? NaN;
      previous = this.states[i - 1];
      state = { price, run:price==null?0:(previous?.run??0)+1, averages: {} };
      let values: (number | null)[];
      let reason:string|undefined=c.studySource && price==null ? input?.reason ?? "Source study has no observed value at this bar; warm-up is held." : undefined;
      switch (c.kind) {
        case "sma": case "ema": case "smma": case "wma":
          values = [average("basis", price, p, c.kind)];
          break;
        case "dema": case "tema": {
          const first = average("first", price, p, "ema");
          const second = average("second", first, p, "ema");
          const third = c.kind === "tema" ? average("third", second, p, "ema") : null;
          values = [first == null || second == null ? null : c.kind === "dema" ? 2 * first - second : third == null ? null : 3 * first - 3 * second + third];
          break;
        }
        case "bollinger": case "stddev": case "cci": {
          const mean = average("basis", price, p, "sma");
          values = c.kind === "bollinger" ? [null, null, null] : [null];
          if (mean != null && price != null) {
            // Preserve centered formulas and summation order without an
            // allocated window per bar. CCI needs absolute deviation only;
            // calculating variance/sqrt as well cannot affect its result.
            // p is a validated integer (chartWorkspace.ts:13, Number.isInteger),
            // so j always indexes prices exactly.
            let sum = 0;
            if (c.kind === "cci") {
              for (let j = i - p + 1; j < i; j++) sum += Math.abs(prices[j]! - mean);
              sum += Math.abs(price - mean);
              const mad = sum / p;
              values = [mad === 0 ? 0 : (price - mean) / (.015 * mad)];
            } else {
              for (let j = i - p + 1; j < i; j++) sum += (prices[j]! - mean) ** 2;
              sum += (price - mean) ** 2;
              const deviation = Math.sqrt(sum / p);
              values = c.kind === "stddev" ? [deviation] : [mean, mean + deviation * (c.multiplier ?? 2), mean - deviation * (c.multiplier ?? 2)];
            }
          }
          break;
        }
        case "rsi": {
          const delta = price != null && previous?.price != null ? price - previous.price : null;
          const gain = average("gain", delta == null ? null : Math.max(0, delta), p, "smma");
          const loss = average("loss", delta == null ? null : Math.max(0, -delta), p, "smma");
          values = [gain == null || loss == null ? null : gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)];
          break;
        }
        case "macd": {
          const fast = average("fast", price, p, "ema");
          const slow = average("slow", price, c.slow ?? 26, "ema");
          const macd = fast == null || slow == null ? null : fast - slow;
          const signal = average("signal", macd, c.signal ?? 9, c.signalMethod ?? "ema");
          values = [macd, signal, macd == null || signal == null ? null : macd - signal];
          break;
        }
        case "atr": {
          const close = bars[i - 1]?.close;
          const range = chartTrueRange(bar, close);
          values = [average("range", range, p, c.method ?? "smma")];
          break;
        }
        case "dmi": {
          // The first candle has no preceding movement. Seed all three Wilder
          // averages from the same p real transitions, then seed ADX from its
          // own full DX window. Revisions reuse the previous bar checkpoint.
          const before = bars[i - 1];
          const up = before ? bar.high - before.high : 0;
          const down = before ? before.low - bar.low : 0;
          const range = before ? Math.max(bar.high - bar.low, Math.abs(bar.high - before.close), Math.abs(bar.low - before.close)) : null;
          const tr = average("tr", range, p, "smma");
          const positive = average("positive", before ? (up > 0 && up > down ? up : 0) : null, p, "smma");
          const negative = average("negative", before ? (down > 0 && down > up ? down : 0) : null, p, "smma");
          const plus = tr == null || positive == null ? null : tr === 0 ? 0 : 100 * positive / tr;
          const minus = tr == null || negative == null ? null : tr === 0 ? 0 : 100 * negative / tr;
          const dx = plus == null || minus == null ? null : plus + minus === 0 ? 0 : 100 * Math.abs(plus - minus) / (plus + minus);
          values = [plus, minus, average("adx", dx, c.signal ?? 14, "smma")];
          break;
        }
        case "stochastic": case "williams": case "donchian": {
          let high = -Infinity, low = Infinity;
          if (highs && lows) { high = highs.push(bar.high, i); low = lows.push(bar.low, i); }
          else if (i >= p - 1) [high, low] = scanChartRange(bars, i - p + 1, i);
          if (c.kind === "donchian") {
            values = i < p - 1 ? [null, null, null] : [high / 2 + low / 2, high, low];
            break;
          }
          // A zero price range has no position; keep the oscillator blank.
          const raw = i < p - 1 || high === low ? null : 100 * (bar.close - low) / (high - low);
          if (c.kind === "williams") values = [raw == null ? null : raw - 100];
          else {
            const k = average("k", raw, c.smoothing ?? 3, "sma");
            values = [k, average("d", k, c.signal ?? 3, "sma")];
          }
          break;
        }
        case "envelopes": {
          const basis = average("basis", price, p, c.method ?? "sma");
          const fraction = (c.multiplier ?? 1) / 100;
          values = basis == null ? [null, null, null] : [basis, basis * (1 + fraction), basis * (1 - fraction)];
          break;
        }
        case "momentum": case "roc": {
          const before = this.states[i - p]?.price;
          const ratio = price == null || state.run <= p || before == null || before === 0 ? null : price / before;
          values = [ratio == null ? null : c.kind === "momentum" ? 100 * ratio : 100 * (ratio - 1)];
          break;
        }
        case "vwap": {
          const anchor=c.vwapAnchor;
          const prior=previous?.vwap;
          const starts=anchor != null && bar.time === anchor.time;
          if(!anchor || bar.time < anchor.time || (!starts && !prior)) {
            values=[null];reason="Exact observed-bar anchor is not present at or before this bar.";break;
          }
          const volume=observedTradeVolume(bar.volumeEvidence);
          const next=starts ? {numerator:0,denominator:0,reason:undefined as string|undefined} : {...prior!};
          if(!next.reason && (!volume || volume.seriesIdentity !== anchor.seriesIdentity))next.reason="Trade-volume evidence is missing, zero, unqualified or belongs to another source series; cumulative VWAP is held from this bar.";
          if(!next.reason && volume) {
            next.numerator+=price!*volume.quantity;next.denominator+=volume.quantity;
            if(!Number.isFinite(next.numerator)||!Number.isSafeInteger(next.denominator)||next.denominator<=0)next.reason="Cumulative volume or weighted price exceeds the supported numerical range.";
          }
          state.vwap=next;reason=next.reason;
          values=[reason ? null : next.numerator/next.denominator];break;
        }
        case "trade_volume": values=[observedTradeVolume(bar.volumeEvidence)?.quantity ?? null];if(values[0]==null)reason="No qualified positive provider-reported trade quantity for this bar.";break;
        case "tick_volume": values = [observedTickVolume(bar.volumeEvidence)]; break;
        default: values = [null];
      }
      this.states.push(state);
      // Normalize the newly created channel array in place; no other owner has it.
      for (let channel = 0; channel < values.length; channel++) {
        const value = values[channel];
        if (value == null || !Number.isFinite(value)) values[channel] = null;
      }
      const point:StudyPoint = { time: bar.time, values, ...(reason ? {reason} : {}) };
      this.points.push(point);
      if (collectChanges) changed.push(point);
    }
    return changed;
  }
}
