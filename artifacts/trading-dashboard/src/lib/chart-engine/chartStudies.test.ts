import { describe, expect, it } from "vitest";
import { STUDY_DEFAULTS, STUDY_CATALOG, appliedPrice, StudyCalculator } from "./chartStudies";
import type { AppliedPrice, AverageMethod, ChartStudy, StudyKind, StudyPoint } from "./chartStudies";
import type { ChartEngineCandle } from "./types";
const bars=(closes:number[])=>closes.map((close,i)=>({time:100+i*60,open:close,high:close,low:close,close}));
describe("close-price study calculations",()=>{
  it("keeps warm-up empty and computes SMA, SMA-seeded EMA and population Bollinger bands",()=>{
    const data=bars([1,2,3,4,3,2,5]);
    expect(new StudyCalculator({kind:"sma",period:3,color:"#ffffff"}).calculate(data).map(p=>p.values[0])).toEqual([null,null,2,3,10/3,3,10/3]);
    expect(new StudyCalculator({kind:"ema",period:3,color:"#ffffff"}).calculate(data).map(p=>p.values[0])).toEqual([null,null,2,3,3,2.5,3.75]);
    const bb=new StudyCalculator({kind:"bollinger",period:3,multiplier:2,color:"#ffffff"}).calculate(data);
    expect(bb[1]!.values).toEqual([null,null,null]);
    expect(bb[2]!.values).toEqual([2,2+2*Math.sqrt(2/3),2-2*Math.sqrt(2/3)]);
  });
  it("uses Wilder RSI with explicit flat, rising and falling cases",()=>{
    const rsi=(values:number[])=>new StudyCalculator({kind:"rsi",period:3,color:"#ffffff"}).calculate(bars(values)).map(p=>p.values[0]);
    expect(rsi([1,2,3,4,3,2,5]).slice(0,4)).toEqual([null,null,null,100]);
    expect(rsi([1,2,3,4,3,2,5])[4]).toBeCloseTo(66.6666667);
    expect(rsi([1,2,3,4,3,2,5])[5]).toBeCloseTo(44.4444444);
    expect(rsi([1,2,3,4,3,2,5])[6]).toBeCloseTo(77.7777778);
    expect(rsi([4,3,2,1])[3]).toBe(0);
    expect(rsi([2,2,2,2])[3]).toBe(50);
  });
  it("seeds MACD and signal independently, then renders a signed histogram",()=>{
    const points=new StudyCalculator({kind:"macd",period:2,slow:3,signal:2,color:"#ffffff"}).calculate(bars([1,2,3,4,5,6]));
    expect(points.map(p=>p.values)).toEqual([[null,null,null],[null,null,null],[.5,null,null],[.5,.5,0],[.5,.5,0],[.5,.5,0]]);
  });
  it.each(STUDY_CATALOG.map(item => item.defaults))("$kind forming-bar revisions and appends equal a clean calculation without compounding",config=>{
    const data=bars(Array.from({length:300},(_,i)=>100+Math.sin(i/8)*5));
    const calculator=new StudyCalculator(config);calculator.calculate(data);
    for(let n=0;n<25;n++){
      data[data.length-1]={...data.at(-1)!,close:100+n*.01};
      expect(calculator.calculate(data,data.length-1)).toHaveLength(1);
      expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data));
    }
    data.push({...data.at(-1)!,time:data.at(-1)!.time+60,close:103});
    calculator.calculate(data,data.length-1);
    expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data));
    data[100]={...data[100]!,close:125};calculator.calculate(data,100);
    expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data));
    calculator.calculate(data.slice(0,50),0);
    expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data.slice(0,50)));
  });
  it("does not change past values when future data arrives",()=>{
    const data=bars(Array.from({length:300},(_,i)=>100+Math.sin(i)));
    for(const config of STUDY_CATALOG.map(item => item.defaults)){const short=new StudyCalculator(config).calculate(data.slice(0,100));expect(new StudyCalculator(config).calculate(data).slice(0,100)).toEqual(short);}
  });
});

describe("independent study reference vectors", () => {
  const calculate = (kind: any, data: ReturnType<typeof bars>, extra = {}) => new StudyCalculator({ kind, period: 3, color: "#ffffff", ...extra }).calculate(data).map(p => p.values);
  it("implements SMMA and linearly weighted MA with different responses", () => {
    const data = bars([1, 2, 3, 6, 5]);
    expect(calculate("smma", data).slice(0, 3).map(p => p[0])).toEqual([null, null, 2]);
    expect(calculate("smma", data)[3]![0]).toBeCloseTo(10 / 3, 10);
    expect(calculate("smma", data)[4]![0]).toBeCloseTo(35 / 9, 10);
    expect(calculate("wma", data)[2]![0]).toBeCloseTo(14 / 6);
    expect(calculate("wma", data)[3]![0]).toBeCloseTo(26 / 6);
    expect(calculate("wma", data)[4]![0]).toBeCloseTo(30 / 6);
  });
  it("warms up EMA cascade stages independently and preserves linear trend", () => {
    const data = bars([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(calculate("dema", data).map(p => p[0])).toEqual([null, null, null, null, 5, 6, 7, 8]);
    expect(calculate("tema", data).map(p => p[0])).toEqual([null, null, null, null, null, null, 7, 8]);
  });
  it("uses an SMA signal for MT5-style MACD and leaves EMA as the existing default", () => {
    const data = bars([1, 2, 3, 4, 6, 3, 8]);
    const sma = calculate("macd", data, { period: 2, slow: 3, signal: 2, signalMethod: "sma" });
    const exponential = calculate("macd", data, { period: 2, slow: 3, signal: 2 });
    // Sixth bar: fast EMA = 67/18, slow EMA = 15/4, MACD = -1/36.
    // SMA signal = mean(previous MACD 2/3, current MACD -1/36) = 23/72.
    expect(sma[4]![1]).toBeCloseTo(7 / 12);
    expect(sma[5]![1]).toBeCloseTo(23 / 72);
    expect(sma[5]![1]).not.toBeCloseTo(exponential[5]![1]!);
  });
  it("ATR includes price gaps and exposes distinct SMA, EMA, Wilder and WMA smoothing", () => {
    const data = [
      { time: 1, open: 9, high: 10, low: 8, close: 9 },
      { time: 2, open: 13, high: 15, low: 12, close: 14 },
      { time: 3, open: 14, high: 15, low: 13, close: 14 },
      { time: 4, open: 9, high: 10, low: 7, close: 8 },
    ]; // True ranges: 2, 6, 2, 7.
    expect(calculate("atr", data, { method: "sma" })[3]![0]).toBeCloseTo(5);
    expect(calculate("atr", data, { method: "ema" })[3]![0]).toBeCloseTo(31 / 6);
    expect(calculate("atr", data, { method: "smma" })[3]![0]).toBeCloseTo(41 / 9);
    expect(calculate("atr", data, { method: "wma" })[3]![0]).toBeCloseTo(31 / 6);
  });
  it("CCI divides the price deviation by 0.015 × mean absolute deviation, not its inverse", () => {
    expect(calculate("cci", bars([1, 2, 3]))[2]![0]).toBeCloseTo(100);
    expect(calculate("cci", bars([3, 2, 1]))[2]![0]).toBeCloseTo(-100);
    expect(calculate("cci", bars([2, 2, 2]))[2]![0]).toBe(0);
    expect(calculate("stddev", bars([1, 2, 3]))[2]![0]).toBeCloseTo(Math.sqrt(2 / 3));
  });
  it("Stochastic and Williams use high/low windows and leave zero range undefined", () => {
    const data = [1, 2, 3, 2, 1, 2].map((close, i) => ({ time: i + 1, open: close, high: close + 1, low: close - 1, close }));
    const k = calculate("stochastic", data, { smoothing: 1, signal: 2 });
    expect(k[2]).toEqual([75, null]);
    expect(k[3]![0]).toBeCloseTo(100 / 3, 10);
    expect(k[3]![1]).toBeCloseTo((75 + 100 / 3) / 2, 10);
    expect(calculate("williams", data)[2]![0]).toBe(-25);
    expect(calculate("stochastic", bars([2, 2, 2, 2]), { smoothing: 1, signal: 1 })[3]).toEqual([null, null]);
    expect(calculate("williams", bars([2, 2, 2]))[2]).toEqual([null]);
  });
  it("distinguishes ratio momentum, percentage change and percentage envelopes", () => {
    expect(calculate("momentum", bars([2, 3, 4, 5]))[3]![0]).toBe(250);
    expect(calculate("roc", bars([2, 3, 4, 5]))[3]![0]).toBe(150);
    expect(calculate("envelopes", bars([1, 2, 3]), { multiplier: 5 })[2]).toEqual([2, 2.1, 1.9]);
  });
  it("selects all eight applied-price inputs without changing OHLC", () => {
    const bar = { time: 1, open: 10, high: 20, low: 8, close: 18 };
    expect(["close", "open", "high", "low", "hl2", "hlc3", "hlcc4", "ohlc4"].map(source => appliedPrice(bar, source as any))).toEqual([18, 10, 20, 8, 14, 46 / 3, 16, 14]);
    expect(calculate("sma", [bar, { ...bar, time: 2 }, { ...bar, time: 3 }], { source: "open" })[2]![0]).toBe(10);
  });
});


describe("render-only calculation retains causal checkpoints without a duplicate change list",()=>{
  it.each(STUDY_CATALOG)("$name preserves default return semantics and exact values",({defaults})=>{
    const data=Array.from({length:220},(_,i)=>({time:100+i*60,open:100,high:103,low:97,close:100+Math.sin(i/7)}));
    const normal=new StudyCalculator(defaults),renderOnly=new StudyCalculator(defaults);
    for(const [next,from] of [[data,0],[data.slice(0,200),200],[data,200],[data.map((b,i)=>i===30?{...b,close:102}:b),30],[data.slice(0,1),1],[data,1],[[],0],[data,0]] as const){
      const changed=normal.calculate([...next],from);
      expect(renderOnly.calculate([...next],from,false)).toEqual([]);
      expect(renderOnly.points).toEqual(normal.points);
      expect(changed).toEqual(normal.points.slice(Math.min(from, next.length)));
    }
  });
});

/* Frozen copy of StudyCalculator at f2c14d6, before the CCI/Bollinger/stddev
 * deviation loops moved to a Float64Array. Do not edit: it is the bit-exact
 * oracle for the tests below (the tests above use toBeCloseTo and would not
 * catch a summation-order change). */
interface ReferenceAverageState { input: number | null; count: number; sum: number; weighted: number; value: number | null }
interface ReferenceState { price: number; averages: Record<string, ReferenceAverageState> }

/** One checkpoint per bar. A revised forming bar replaces its checkpoint;
 * appends never compound a previous revision, and replay never reads the future.
 * Rolling means, weighted means and recursive smoothing are O(1) per update.
 * Deviation/high-low windows are bounded by the validated period (max 1,000).
 * See docs/SMART_CHART_STUDY_CONVENTIONS.md for seeds and flat-market choices. */
class ReferenceStudyCalculator {
  private states: ReferenceState[] = [];
  readonly points: StudyPoint[] = [];
  constructor(readonly config: ChartStudy) {}

  /** Rendering reads points directly and can omit the duplicate changed list.
   * Default callers still receive every changed point in its original order. */
  calculate(bars: ChartEngineCandle[], from = 0, collectChanges = true): StudyPoint[] {
    const c = this.config;
    const p = c.period;
    from = Math.max(0, Math.min(from, this.states.length, bars.length));
    this.states.length = from;
    this.points.length = from;
    const changed: StudyPoint[] = [];
    let i = from;
    let state: ReferenceState;
    let previous: ReferenceState | undefined;
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
    for (i = from; i < bars.length; i++) {
      const bar = bars[i]!;
      const price = appliedPrice(bar, c.source ?? (c.kind === "cci" ? "hlc3" : "close"));
      state = { price, averages: {} };
      previous = this.states[i - 1];
      let values: (number | null)[];
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
        default: values = [null];
      }
      this.states.push(state);
      // Normalize the newly created channel array in place; no other owner has it.
      for (let channel = 0; channel < values.length; channel++) {
        const value = values[channel];
        if (value == null || !Number.isFinite(value)) values[channel] = null;
      }
      const point = { time: bar.time, values };
      this.points.push(point);
      if (collectChanges) changed.push(point);
    }
    return changed;
  }
}

describe("typed price window is bit-identical to the frozen State-object loops", () => {
  // Seeded (mulberry32) random walk with irregular decimals so a reordered or
  // compensated summation would change low-order bits.
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const series = (length: number, seed: number): ChartEngineCandle[] => {
    const random = seeded(seed);
    let close = 1.1;
    return Array.from({ length }, (_, i) => {
      const open = close;
      close = Math.max(0.2, open + (random() - 0.5) * 0.004);
      // A few flat bars exercise the mad === 0 and zero-deviation branches.
      if (i % 997 === 0) close = open;
      return { time: 1_700_000_000 + i * 300, open, close, high: Math.max(open, close) + random() * 0.002, low: Math.min(open, close) - random() * 0.002 };
    });
  };
  const bars5000 = series(5000, 20261028);
  const sources: (AppliedPrice | undefined)[] = [undefined, "close", "open", "high", "low", "hl2", "hlc3", "hlcc4", "ohlc4"];
  const periods = [2, 14, 200, 1000];
  const windowed: StudyKind[] = ["bollinger", "stddev", "cci"];
  const mismatch = (actual: StudyPoint[], expected: StudyPoint[]): string | undefined => {
    if (actual.length !== expected.length) return `length ${actual.length} !== ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i]!, e = expected[i]!;
      if (!Object.is(a.time, e.time) || a.values.length !== e.values.length) return `bar ${i} shape`;
      for (let k = 0; k < e.values.length; k++) if (!Object.is(a.values[k], e.values[k])) return `bar ${i} channel ${k}: ${a.values[k]} !== ${e.values[k]}`;
    }
    return undefined;
  };
  const reference = (config: ChartStudy, data: ChartEngineCandle[]) => new ReferenceStudyCalculator(config).calculate(data);
  // Strip source from the catalog defaults (CCI defaults carry hlc3) so the
  // undefined case really exercises the `c.source ?? ...` fallback for every kind.
  const configs = STUDY_CATALOG.flatMap(({ defaults: { source: _catalogSource, ...defaults }, appliedPrice: priced }) => periods.flatMap(period =>
    (priced ? sources : [undefined]).map(source => ({ ...defaults, period, ...(source ? { source } : {}) }) as ChartStudy)));

  it.each(STUDY_CATALOG.map(item => item.defaults.kind))("%s full calculation matches by Object.is for every source and period 2/14/200/1000", kind => {
    expect(configs.some(item => item.kind === kind && !("source" in item)), `${kind} has a config with no source key`).toBe(true);
    for (const config of configs.filter(item => item.kind === kind)) {
      const expected = reference(config, bars5000);
      const label = `${config.kind} p=${config.period} ${config.source ?? "default"}`;
      expect(mismatch(new StudyCalculator(config).calculate(bars5000), expected), label).toBeUndefined();
      const renderOnly = new StudyCalculator(config);
      expect(renderOnly.calculate(bars5000, 0, false)).toEqual([]);
      expect(mismatch(renderOnly.points, expected), `${label} render-only`).toBeUndefined();
    }
  });

  it.each(windowed.flatMap(kind => (["hlc3", "close", undefined] as const).map(source => [kind, source] as const)))(
    "%s %s p=1000 stays exact through forming-bar revisions, truncation, re-append and buffer growth", (kind, source) => {
      const config: ChartStudy = { kind, period: 1000, color: "#ffffff", multiplier: 2, ...(source ? { source } : {}) };
      const data = bars5000.slice();
      const calculator = new StudyCalculator(config);
      calculator.calculate(data);
      // Revised forming bar, recalculated incrementally from the last index.
      for (const close of [1.31, 0.97, data.at(-1)!.close]) {
        data[data.length - 1] = { ...data.at(-1)!, close, high: Math.max(data.at(-1)!.high, close), low: Math.min(data.at(-1)!.low, close) };
        expect(calculator.calculate(data, data.length - 1)).toHaveLength(1);
        expect(mismatch(calculator.points, reference(config, data)), `revision ${close}`).toBeUndefined();
      }
      // Truncate, then re-append different prices: a stale buffer entry at or
      // above the truncation point must never be read.
      calculator.calculate(data.slice(0, 2500), 2500);
      expect(mismatch(calculator.points, reference(config, data.slice(0, 2500))), "truncated").toBeUndefined();
      const replaced = [...data.slice(0, 2500), ...series(2500, 7).map((bar, i) => ({ ...bar, time: data[2500 + i]!.time }))];
      calculator.calculate(replaced, 2500);
      expect(mismatch(calculator.points, reference(config, replaced)), "re-appended").toBeUndefined();
      // Growth from a small buffer by appends and in-place edits.
      const growing = new StudyCalculator(config);
      growing.calculate(replaced.slice(0, 5), 0);
      for (const end of [999, 1000, 1001, 1500, 2047, 3333, 4999, 5000]) growing.calculate(replaced.slice(0, end), end - 3);
      expect(mismatch(growing.points, reference(config, replaced)), "grown").toBeUndefined();
      const edited = replaced.map((bar, i) => i === 1800 ? { ...bar, close: bar.close + 0.01, high: bar.high + 0.01 } : bar);
      growing.calculate(edited, 1800);
      expect(mismatch(growing.points, reference(config, edited)), "edited middle").toBeUndefined();
    });

  /* Performance properties of the price buffer, observed through the private
   * field and a counting wrapper on Float64Array.prototype.set (no test hook):
   * a tick or an append that fits never reallocates or copies, growth at least
   * doubles, growth copies only the still-valid prefix, and no call re-reads
   * old prices from State objects or bars. */
  it.each(windowed)("%s price buffer is reused, grows by doubling and copies only the valid prefix", kind => {
    const config: ChartStudy = { kind, period: 1000, color: "#ffffff", multiplier: 2 };
    const data = series(6_100, 99);
    const calculator = new StudyCalculator(config);
    const buffer = () => (calculator as unknown as { prices: Float64Array }).prices;
    const states = () => (calculator as unknown as { states: { price: number }[] }).states;
    const copies: number[] = [];
    let priceReads = 0, oldBarReads = 0;
    // Count State.price reads on every checkpoint that existed before the call.
    const watchStates = () => { for (const state of states()) { const value = state.price; Object.defineProperty(state, "price", { get: () => { priceReads++; return value; } }); } };
    // Count reads of any bar below `from`; a deviation window is read from the buffer, never from bars.
    const watched = (bars: ChartEngineCandle[], from: number) => new Proxy(bars, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key) && Number(key) < from) oldBarReads++;
      return Reflect.get(target, key, receiver);
    } });
    const run = (n: number, from: number) => {
      watchStates(); priceReads = 0; oldBarReads = 0;
      calculator.calculate(watched(data.slice(0, n), from), from, false);
      expect(priceReads, `State.price reads n=${n} from=${from}`).toBe(0);
      expect(oldBarReads, `bar reads below from n=${n} from=${from}`).toBe(0);
    };
    const typedArraySet = Object.getPrototypeOf(Float64Array.prototype).set as Float64Array["set"];
    Object.defineProperty(Float64Array.prototype, "set", { configurable: true, writable: true, value(this: Float64Array, source: ArrayLike<number>, offset?: number) {
      copies.push(source.length);
      return typedArraySet.call(this, source, offset);
    } });
    try {
      calculator.calculate(data.slice(0, 3000), 0, false);
      const first = buffer();
      const capacity = first.length;
      expect(capacity).toBeGreaterThanOrEqual(3000);
      copies.length = 0;
      // Repeated forming-bar ticks: same object, no copy, O(p) work.
      for (let tick = 0; tick < 5; tick++) { run(3000, 2999); expect(buffer()).toBe(first); }
      // Single-bar appends: same object until n exceeds capacity.
      let n = 3000;
      while (n < capacity) { n++; run(n, n - 1); expect(buffer(), `append n=${n}`).toBe(first); }
      expect(copies, "no copy while within capacity").toEqual([]);
      // Overflow by one bar: capacity at least doubles; only the n-1 valid prices are copied.
      n++; run(n, n - 1);
      const second = buffer();
      expect(second).not.toBe(first);
      expect(second.length).toBeGreaterThanOrEqual(2 * capacity);
      expect(copies).toEqual([n - 1]);
      copies.length = 0;
      // Appending again stays within the doubled buffer.
      for (let k = 0; k < 3; k++) { n++; run(n, n - 1); expect(buffer()).toBe(second); }
      run(n, n - 1);
      expect(buffer()).toBe(second);
      expect(copies).toEqual([]);
      // Truncate well below capacity, then grow past it: only the 2,000-price
      // valid prefix is copied, not the whole old buffer or the stale tail.
      run(2000, 2000);
      expect(buffer()).toBe(second);
      run(second.length + 1, 2000);
      const third = buffer();
      expect(third).not.toBe(second);
      expect(third.length).toBeGreaterThanOrEqual(2 * second.length);
      expect(copies).toEqual([2000]);
      expect(mismatch(calculator.points, reference(config, data.slice(0, second.length + 1))), "after growth").toBeUndefined();
    } finally {
      delete (Float64Array.prototype as { set?: unknown }).set;
    }
    expect(Float64Array.prototype.set).toBe(typedArraySet);
  });
});
