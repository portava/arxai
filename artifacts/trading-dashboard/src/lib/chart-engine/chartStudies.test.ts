import { describe, expect, it } from "vitest";
import { STUDY_DEFAULTS, STUDY_CATALOG, appliedPrice, StudyCalculator } from "./chartStudies";
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
