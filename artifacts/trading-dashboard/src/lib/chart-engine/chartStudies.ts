import type { ChartEngineCandle } from "./types";

export type StudyKind =
  | "sma" | "ema" | "smma" | "wma" | "dema" | "tema" | "bollinger"
  | "rsi" | "macd" | "atr" | "cci" | "stochastic" | "williams"
  | "stddev" | "envelopes" | "momentum" | "roc";
export type AppliedPrice = "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "hlcc4" | "ohlc4";
export type AverageMethod = "sma" | "ema" | "smma" | "wma";
export interface ChartStudy {
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
}
export interface StudyPoint { time: number; values: (number | null)[] }
export interface StudyDefinition {
  name: string;
  group: "Trend" | "Momentum" | "Volatility";
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
];
/** Preserve the original starter collection and saved templates. */
export const STUDY_DEFAULTS = STUDY_CATALOG.slice(0, 5).map(item => item.defaults);
export const MAX_STUDIES = 12;
export const studyDefinition = (kind: StudyKind) => STUDY_CATALOG.find(item => item.defaults.kind === kind)!;
export const studyId = (study: ChartStudy) => study.id ?? study.kind;
export function studyLabel(study: ChartStudy): string {
  const parameters = [study.period];
  if (study.kind === "macd") parameters.push(study.slow ?? 26, study.signal ?? 9);
  if (study.kind === "stochastic") parameters.push(study.smoothing ?? 3, study.signal ?? 3);
  if (study.kind === "bollinger" || study.kind === "envelopes") parameters.push(study.multiplier ?? 2);
  const source = studyDefinition(study.kind).appliedPrice ? ` · ${study.source ?? (study.kind === "cci" ? "hlc3" : "close")}` : "";
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

interface AverageState { input: number | null; count: number; sum: number; weighted: number; value: number | null }
interface State { price: number; averages: Record<string, AverageState> }

/** One checkpoint per bar. A revised forming bar replaces its checkpoint;
 * appends never compound a previous revision, and replay never reads the future.
 * Rolling means, weighted means and recursive smoothing are O(1) per update.
 * Deviation/high-low windows are bounded by the validated period (max 1,000).
 * See docs/SMART_CHART_STUDY_CONVENTIONS.md for seeds and flat-market choices. */
export class StudyCalculator {
  private states: State[] = [];
  readonly points: StudyPoint[] = [];
  constructor(readonly config: ChartStudy) {}

  calculate(bars: ChartEngineCandle[], from = 0): StudyPoint[] {
    const c = this.config;
    const p = c.period;
    from = Math.max(0, Math.min(from, this.states.length, bars.length));
    this.states.length = from;
    this.points.length = from;
    const changed: StudyPoint[] = [];
    for (let i = from; i < bars.length; i++) {
      const bar = bars[i]!;
      const price = appliedPrice(bar, c.source ?? (c.kind === "cci" ? "hlc3" : "close"));
      const state: State = { price, averages: {} };
      const previous = this.states[i - 1];
      const average = (key: string, input: number | null, period: number, method: AverageMethod): number | null => {
        const prior = previous?.averages[key];
        const count = input == null ? 0 : (prior?.count ?? 0) + 1;
        const expired = this.states[i - period]?.averages[key]?.input ?? 0;
        const sum = input == null ? 0 : (prior?.sum ?? 0) + input - (count > period ? expired : 0);
        const weighted = method !== "wma" || input == null ? 0 : count <= period
          ? (prior?.weighted ?? 0) + count * input
          : (prior?.weighted ?? 0) - (prior?.sum ?? 0) + period * input;
        let value: number | null = null;
        if (input != null && count >= period) {
          if (method === "wma") value = weighted / (period * (period + 1) / 2);
          else if (method === "sma" || prior?.value == null) value = sum / period;
          else value = prior.value + (method === "smma" ? 1 / period : 2 / (period + 1)) * (input - prior.value);
        }
        state.averages[key] = { input, count, sum, weighted, value };
        return value;
      };
      let values: (number | null)[] = [null];
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
          if (mean != null) {
            // Preserve centered formulas and summation order without an
            // allocated window per bar. CCI needs absolute deviation only;
            // calculating variance/sqrt as well cannot affect its result.
            let sum = 0;
            if (c.kind === "cci") {
              for (let j = i - p + 1; j < i; j++) sum += Math.abs(this.states[j]!.price - mean);
              sum += Math.abs(price - mean);
              const mad = sum / p;
              values = [mad === 0 ? 0 : (price - mean) / (.015 * mad)];
            } else {
              for (let j = i - p + 1; j < i; j++) sum += (this.states[j]!.price - mean) ** 2;
              sum += (price - mean) ** 2;
              const deviation = Math.sqrt(sum / p);
              values = c.kind === "stddev" ? [deviation] : [mean, mean + deviation * (c.multiplier ?? 2), mean - deviation * (c.multiplier ?? 2)];
            }
          }
          break;
        }
        case "rsi": {
          const delta = previous ? price - previous.price : null;
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
          const range = close == null ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - close), Math.abs(bar.low - close));
          values = [average("range", range, p, c.method ?? "smma")];
          break;
        }
        case "stochastic": case "williams": {
          let high = -Infinity, low = Infinity;
          if (i >= p - 1) for (let j = i - p + 1; j <= i; j++) { high = Math.max(high, bars[j]!.high); low = Math.min(low, bars[j]!.low); }
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
          const ratio = before == null || before === 0 ? null : price / before;
          values = [ratio == null ? null : c.kind === "momentum" ? 100 * ratio : 100 * (ratio - 1)];
          break;
        }
      }
      this.states.push(state);
      const point = { time: bar.time, values: values.map(value => value != null && Number.isFinite(value) ? value : null) };
      this.points.push(point);
      changed.push(point);
    }
    return changed;
  }
}
