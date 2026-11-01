import { describe, expect, it } from "vitest";
import { analyzeSmartChart, bindSmartChartBars, smartChartIntervalSeconds, type SmartChartAnalysisBar, type SmartChartAnalysisInput } from "./smartChartAnalysis";
import { detectChartPatterns } from "@workspace/domain/chart-patterns";

const START = 1_700_000_000;
const CONTEXT = { symbol: "EURUSD", timeframe: "M5", source: "mt5_broker", sourceIdentity: "a".repeat(64) };
type OHLC = Pick<SmartChartAnalysisBar, "open" | "high" | "low" | "close">;
function bars(rows: OHLC[]): SmartChartAnalysisBar[] {
  return rows.map((b, i) => ({ ...b, time: START + i * 300, closeTime: START + (i + 1) * 300, isComplete: true, isFinal: true, isForming: false }));
}
function flat(n: number, p = 100): SmartChartAnalysisBar[] {
  return bars(Array.from({ length: n }, () => ({ open: p, high: p + 0.3, low: p - 0.3, close: p })));
}
function input(candles: SmartChartAnalysisBar[], extra: Partial<SmartChartAnalysisInput> = {}): SmartChartAnalysisInput {
  return { ...CONTEXT, bars: candles, asOfMs: (candles.at(-1)!.closeTime + 0.01) * 1000, dataState: "current", ...extra };
}
function rows(values: number[]): OHLC[] {
  return values.map(close => ({ open: close - 0.05, high: close + 0.2, low: close - 0.2, close }));
}
function hs(): SmartChartAnalysisBar[] {
  const points = [[0, 90], [8, 96], [12, 105], [16, 99], [20, 112], [24, 99], [28, 105], [30, 102], [31, 98], [32, 97]];
  const closes: number[] = [];
  for (let i = 0; i <= 32; i++) {
    const right = points.findIndex(p => p[0]! >= i);
    if (right === 0) closes.push(points[0]![1]!);
    else { const a = points[right - 1]!, b = points[right]!; closes.push(a[1]! + (b[1]! - a[1]!) * (i - a[0]!) / (b[0]! - a[0]!)); }
  }
  return bars(rows(closes));
}
function inverted(candles: SmartChartAnalysisBar[]) {
  return candles.map(b => ({ ...b, open: 220 - b.open, high: 220 - b.low, low: 220 - b.high, close: 220 - b.close }));
}
const uptrend = [1, 1.01, 1.02, 1.03, 1.04].map(close => ({ open: close - 0.001, high: close + 0.001, low: close - 0.002, close }));
const star = { open: 1.04, high: 1.06, low: 1.0395, close: 1.041 };
const find = (data: SmartChartAnalysisInput, prefix: string) => analyzeSmartChart(data).allFindings.find(f => f.id.startsWith(prefix));

describe("bounded head-and-shoulders discovery scope", () => {
  it("matches full-catalogue H&S evidence at every prefix without returning other families", () => {
    let seed = 307;
    const dense = bars(Array.from({ length: 600 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const close = 100 + seed / 4294967296 * 10;
      return { open: close - .1, close, high: close + .5, low: close - .5 };
    }));
    let matched = 0, excluded = 0;
    for (const candles of [hs(), inverted(hs()), dense]) {
      for (let end = 0; end <= candles.length; end++) {
        const prefix = candles.slice(0, end);
        const all = detectChartPatterns(prefix);
        const selected = detectChartPatterns(prefix, "head-and-shoulders");
        const expected = all.patterns.filter(p => p.id === "head_and_shoulders" || p.id === "inverse_head_and_shoulders");
        expect(selected).toEqual({ ...all, patterns: expected });
        matched += expected.length;
        excluded += all.patterns.length - expected.length;
      }
    }
    expect(matched).toBeGreaterThan(0);
    expect(excluded).toBeGreaterThan(0);
  });
  it("retains forming-tail filtering and short-window metadata in the narrow scope", () => {
    const closed = hs();
    const forming = { ...closed.at(-1)!, close: 150, high: 151, isComplete: false, isForming: true };
    expect(detectChartPatterns([...closed, forming], "head-and-shoulders"))
      .toEqual(detectChartPatterns(closed, "head-and-shoulders"));
    expect(detectChartPatterns(closed.slice(0, 19), "head-and-shoulders"))
      .toEqual({ patterns: [], candlesConsidered: 19, insufficient: true });
  });
});

describe("source and observation boundaries", () => {
  it.each(["symbol", "timeframe", "source", "sourceIdentity"] as const)("refuses a batch from another %s", key => {
    const changed = { ...CONTEXT, [key]: key === "timeframe" ? "M15" : key === "sourceIdentity" ? "b".repeat(64) : "different" };
    expect(bindSmartChartBars(CONTEXT, [{ evidence: changed, bars: flat(30) }]).status).toBe("unavailable");
  });
  it.each(["unknown", " unknown ", "mt5_broker "])("refuses an ambiguous source identifier %s", source => {
    expect(analyzeSmartChart(input(flat(30), { source })).status).toBe("unavailable");
  });
  it("merges only matching provenance, retaining exact overlapping observations", () => {
    const b = flat(30);
    const result = bindSmartChartBars(CONTEXT, [{ evidence: CONTEXT, bars: b.slice(0, 20) }, { evidence: CONTEXT, bars: b.slice(10) }]);
    expect(result.status).toBe("ready"); expect(result.bars).toEqual(b);
    expect(result.bars[0]).not.toBe(b[0]);
    expect(bindSmartChartBars(CONTEXT, [{ evidence: CONTEXT, bars: b }, { evidence: CONTEXT, bars: [{ ...b[0]!, close: 100.1 }] }]).status).toBe("unavailable");
  });
  it.each([null, "", "bridge-1", "A".repeat(64)])("requires an observed opaque identity, not %s", sourceIdentity => {
    expect(analyzeSmartChart(input(flat(30), { sourceIdentity })).status).toBe("unavailable");
  });
  it("refuses contradictory finality rather than silently treating it as closed", () => {
    for (const override of [{ isFinal: false }, { isForming: true }]) {
      const b = flat(30); b[29] = { ...b[29]!, ...override };
      expect(analyzeSmartChart(input(b)).status).toBe("unavailable");
    }
  });
  it("excludes a genuine forming candle and never uses a future scheduled close as confirmation", () => {
    const b = hs(); const forming = { ...b[31]!, isComplete: false, isFinal: false, isForming: true };
    const result = analyzeSmartChart(input([...b.slice(0, 31), forming], { asOfMs: forming.time * 1000 + 10 }));
    expect(result.status).toBe("ready"); expect(result.closedBarsUsed).toBe(31);
    expect(result.allFindings.find(f => f.id.startsWith("head_and_shoulders"))?.status).toBe("developing");
    expect(analyzeSmartChart(input(b.slice(0, 32), { asOfMs: forming.time * 1000 + 10 })).status).toBe("unavailable");
  });
  it.each([
    { high: 0 }, { high: NaN }, { low: Infinity }, { open: 101 }, { close: -1 },
    { closeTime: START + 301 },
  ])("rejects malformed OHLC or a wrong interval: %j", change => {
    const b = flat(30); b[0] = { ...b[0]!, ...change };
    expect(analyzeSmartChart(input(b)).status).toBe("unavailable");
  });
  it("requires unique chronological candles", () => {
    const b = flat(30);
    expect(analyzeSmartChart(input([b[1]!, b[0]!, ...b.slice(2)])).status).toBe("unavailable");
    expect(analyzeSmartChart(input([b[0]!, ...b])).status).toBe("unavailable");
  });
  it.each([{ asOfMs: NaN }, { visibleRange: { from: 2, to: 1 } }, { visibleRange: { from: NaN, to: START } }, { replayCutoff: Infinity }, { replayCutoff: START + 1e9 }])("rejects invalid analysis bounds %j", override => {
    expect(analyzeSmartChart(input(flat(30), override)).status).toBe("unavailable");
  });
  it("replay is prefix-causal even when later OHLC values are changed", () => {
    const b = hs(), cutoff = b[30]!.closeTime;
    const whole = input(b, { replayCutoff: cutoff });
    const prefix = input(b.slice(0, 31), { asOfMs: whole.asOfMs, replayCutoff: cutoff });
    expect(analyzeSmartChart(whole)).toEqual(analyzeSmartChart(prefix));
    expect(analyzeSmartChart({ ...whole, bars: b.map((v, i) => i < 31 ? v : { ...v, close: 9999 }) })).toEqual(analyzeSmartChart(prefix));
  });
  it("visible ranges use seconds and do not read later candles", () => {
    const b = hs(), range = { from: b[0]!.time, to: b[30]!.time };
    expect(find(input(b, { visibleRange: range }), "head_and_shoulders")?.status).toBe("developing");
    expect(analyzeSmartChart(input(b, { visibleRange: range })).closedBarsUsed).toBe(31);
  });
  it("exposes bounded coverage rather than silently hiding a history truncation", () => {
    const result = analyzeSmartChart(input(flat(5000)));
    expect(result.coverage).toMatchObject({ available: 5000, analyzed: 600, truncated: true });
    expect(result.coverage.note).toContain("600 of 5000");
  });
  it("matches supported fixed chart intervals and never guesses a calendar month or unknown timeframe", () => {
    expect(smartChartIntervalSeconds("M5")).toBe(300);
    expect(smartChartIntervalSeconds("MN1")).toBeNull();
    expect(smartChartIntervalSeconds("5m")).toBeNull();
  });
});

describe("existing geometry, causal confirmation and plain English", () => {
  it("reuses the actual H&S detector and confirms only after the right shoulder can be observed", () => {
    const b = hs();
    expect(detectChartPatterns(b).patterns.some(p => p.id === "head_and_shoulders")).toBe(true);
    expect(find(input(b.slice(0, 30)), "head_and_shoulders")).toBeUndefined();
    const developing = find(input(b.slice(0, 31)), "head_and_shoulders")!;
    expect(developing.status).toBe("developing"); expect(developing.confirmedAt).toBeUndefined();
    const confirmed = find(input(b), "head_and_shoulders")!;
    expect(confirmed.status).toBe("confirmed"); expect(confirmed.confirmedAt).toBe(b[31]!.closeTime);
    expect(confirmed.confirmedAt!).toBeGreaterThanOrEqual(b[30]!.closeTime);
    expect(confirmed.anchors.map(p => p.role)).toEqual(["left_shoulder", "neckline_left", "head", "neckline_right", "right_shoulder"]);
    expect(confirmed.anchors.find(p => p.role === "head")!.price).toBe(b[20]!.high);
    expect(confirmed.explanation).toContain("112.2"); expect(confirmed.invalidation).toContain("neckline");
  });
  it("requires distinct actual neckline pivots on both sides of the head", () => {
    const b = hs();
    b[4] = { ...b[4]!, low: 89 };
    for (let i = 21; i <= 27; i++) b[i] = { ...b[i]!, low: 98 };
    // The unchanged catalogue permits one intervening trough; the chart boundary must not.
    expect(detectChartPatterns(b).patterns.some(p => p.id === "head_and_shoulders")).toBe(true);
    expect(find(input(b), "head_and_shoulders")).toBeUndefined();
  });
  it("retains supported catalogue observations at their actual 20-bar minimum", () => {
    const b = flat(20);
    b[8] = { ...b[8]!, high: 102 };
    b[19] = { ...b[19]!, high: 103, close: 100.1 };
    expect(detectChartPatterns(b).patterns.some(p => p.id === "liquidity_sweep_high")).toBe(true);
    const f = find(input(b), "liquidity_sweep_high")!;
    expect(f.status).toBe("confirmed");
    expect(f.explanation).not.toContain("stop run");
    expect(f.caveat).toContain("actual order flow were not measured");
  });
  it("mirrors the same real geometry for inverse H&S", () => {
    const b = inverted(hs());
    const f = find(input(b), "inverse_head_and_shoulders")!;
    expect(f.status).toBe("confirmed"); expect(f.confirmedAt).toBe(b[31]!.closeTime);
    expect(f.explanation).toContain("above");
  });
  it("invalidates a previously confirmed H&S when a later close crosses back through its neckline", () => {
    const b = hs(), last = b.at(-1)!;
    const rebound = { ...last, time: last.closeTime, closeTime: last.closeTime + 300, open: 99, high: 101, low: 98.5, close: 100 };
    expect(find(input([...b, rebound]), "head_and_shoulders")?.status).toBe("invalidated");
  });
  it("does not describe a reversal without the preceding directional move", () => {
    const b = hs(); for (let i = 7; i <= 11; i++) b[i] = { ...b[i]!, open: 106, close: 106, high: 106.2, low: 105.8 };
    expect(find(input(b), "head_and_shoulders")).toBeUndefined();
  });
  it("requires the close after a shooting star; wick-only follow-through is not confirmation", () => {
    const b = bars([...uptrend, star]);
    expect(find(input(b), "shooting_star")?.status).toBe("developing");
    const wick = bars([...uptrend, star, { open: 1.041, high: 1.045, low: 1.03, close: 1.04 }]);
    expect(find(input(wick), "shooting_star")?.status).toBe("observed");
    const confirm = bars([...uptrend, star, { open: 1.041, high: 1.042, low: 1.03, close: 1.035 }]);
    expect(find(input(confirm), "shooting_star")?.confirmedAt).toBe(confirm[6]!.closeTime);
    const fail = bars([...uptrend, star, { open: 1.041, high: 1.07, low: 1.04, close: 1.065 }]);
    expect(find(input(fail), "shooting_star")?.status).toBe("invalidated");
  });
  it("does not turn delayed follow-through into next-candle shooting-star confirmation", () => {
    const b = bars([...uptrend, star,
      { open: 1.041, high: 1.045, low: 1.03, close: 1.04 },
      { open: 1.04, high: 1.041, low: 1.02, close: 1.025 }]);
    const f = find(input(b), "shooting_star")!;
    expect(f.status).toBe("observed"); expect(f.confirmedAt).toBeUndefined();
    expect(f.explanation).toContain("next close did not confirm");
  });
  it("timestamps a later shooting-star invalidation at the observed endpoint", () => {
    const b = bars([...uptrend, star,
      { open: 1.041, high: 1.042, low: 1.03, close: 1.035 },
      { open: 1.035, high: 1.04, low: 1.03, close: 1.038 },
      { open: 1.038, high: 1.08, low: 1.03, close: 1.07 }]);
    const f = find(input(b), "shooting_star")!;
    expect(f.status).toBe("invalidated");
    expect(f.confirmedAt).toBe(b[6]!.closeTime);
    expect(f.asOf).toBe(b[8]!.closeTime);
  });
  it("does not call a long upper wick after a decline a shooting star", () => {
    const b = bars([...uptrend].reverse().concat({ ...star, open: 1, close: 1.001, low: 0.9995, high: 1.02 }));
    expect(find(input(b), "shooting_star")).toBeUndefined();
  });
  it("reports Doji as observed neutral geometry with an explicit threshold, not a forecast", () => {
    const b = bars([{ open: 1.1, high: 1.12, low: 1.08, close: 1.101 }]);
    const f = find(input(b), "doji")!;
    expect(f.status).toBe("observed"); expect(f.confirmedAt).toBeUndefined();
    expect(f.explanation).toContain("does not establish a direction"); expect(f.caveat).toContain("at most 10%");
    expect(find(input(bars([{ open: 1, high: 1, low: 1, close: 1 }])), "doji")).toBeUndefined();
  });
  it("keeps small price changes and does not label every small-bodied candle a Doji", () => {
    expect(find(input(bars([{ open: 1e-7, high: 1.2e-7, low: 0.8e-7, close: 1.01e-7 }])), "doji")?.explanation).toContain("1.01e-7");
    expect(find(input(bars([{ open: 100, high: 101, low: 99, close: 100.21 }])), "doji")).toBeUndefined();
  });
  it("uses real engulfing bodies after the appropriate prior trend and distinguishes shape from outcome", () => {
    const fall = [1.04, 1.03, 1.02, 1.01, 1].map(close => ({ open: close + 0.001, high: close + 0.002, low: close - 0.001, close }));
    const b = bars([...fall, { open: 0.999, high: 1.004, low: 0.998, close: 1.003 }]);
    const f = find(input(b), "bullish_engulfing")!;
    expect(f.status).toBe("confirmed"); expect(f.confirmedAt).toBe(b[5]!.closeTime);
    expect(f.explanation).toContain("a market reversal is not");
    expect(find(input(inverted(b)), "bearish_engulfing")?.status).toBe("confirmed");
  });
  it("separates a fitted trendline close break from an unconfirmed wick test", () => {
    const prefix = flat(29);
    const last = { ...prefix.at(-1)!, time: START + 29 * 300, closeTime: START + 30 * 300, open: 100, high: 101.2, low: 99.9, close: 101 };
    const f = find(input([...prefix, last]), "trendline_break")!;
    expect(f.status).toBe("confirmed"); expect(f.explanation).toContain("29 prior candles");
    expect(find(input([...prefix, { ...last, close: 100.1 }]), "trendline_break")?.status).toBe("observed");
  });
  it("has deterministic bounded summary families and retains other findings in details", () => {
    const args = input(flat(60));
    const a = analyzeSmartChart(args), b = analyzeSmartChart(args);
    expect(a).toEqual(b); expect(a.findings.length).toBeLessThanOrEqual(3);
    expect(a.findings.filter(f => f.title === "Doji")).toHaveLength(1);
    expect(a.allFindings.filter(f => f.title === "Doji").length).toBeGreaterThan(1);
    expect(JSON.stringify(a)).not.toMatch(/"confidence"|"buy"|"sell"|READY_NOW|trade_now/);
    expect(args.bars).toEqual(flat(60));
  });
  it("labels stale/replay evidence and unmeasured volume honestly", () => {
    const b = hs();
    expect(find(input(b, { dataState: "stale" }), "head_and_shoulders")!.caveat).toContain("feed is stale");
    expect(find(input(b, { replayCutoff: b.at(-1)!.closeTime }), "head_and_shoulders")!.caveat).toContain("Replay");
    expect(find(input(b), "head_and_shoulders")!.caveat).toContain("Volume confirmation and actual order flow were not measured");
    const staleWindow = find(input(b, { dataState: "stale", visibleRange: { from: b[0]!.time, to: b.at(-1)!.time } }), "head_and_shoulders")!;
    expect(staleWindow.caveat).toContain("Historical chart window");
    expect(staleWindow.caveat).toContain("feed is stale");
  });
});

it("carries breakout/retest event geometry without claiming a connecting price path",()=>{
 const source=bars([...flat(16),...[
 [100,100.2,99.8,100.1],[100.1,100.4,100,100.3],[100.3,101,100.2,100.6],
 [100.4,100.5,100,100.2],[100.2,100.4,99.9,100.1],[100.1,100.6,100,100.4],
 [100.4,101,100.3,100.6],[100.6,100.7,100.1,100.3],[100.3,100.6,100,100.2],
 [100.2,102.2,100.1,102],[102,102.1,100.9,101.3],[101.3,101.7,101,101.5],
 [101.5,103,101.5,102.8]
 ].map(([open,high,low,close])=>({open:open!,high:high!,low:low!,close:close!}))]);
 const finding=find(input(source),"breakout_retest_up");
 expect(finding).toMatchObject({connectAnchors:false});
 expect(finding?.confirmedAt).toBe(source[26]!.closeTime);
 const forming=find(input(source.slice(0,26)),"breakout_retest_up");expect(forming?.status).toBe("developing");expect(forming?.id).toBe(finding?.id);
 expect(find(input(source,{replayCutoff:source[25]!.closeTime}),"breakout_retest_up")?.confirmedAt).toBeUndefined();
 expect(find(input(source,{replayCutoff:source[26]!.closeTime}),"breakout_retest_up")?.confirmedAt).toBe(source[26]!.closeTime);
 expect(finding?.anchors.find(a=>a.role==="retest")).toEqual({time:source[26]!.time,price:101,role:"retest"});
 const withoutTouch=bars([...source.slice(0,26),{open:102,high:103,low:102,close:102.8},{open:102.8,high:104,low:102.8,close:103.8}]);
 expect(find(input(withoutTouch),"breakout_retest_up")?.anchors.map(a=>a.role)).toEqual(["broken_level"]);
});

// The same swing geometry may only qualify after later volatility changes.
// Confirmation cannot be assigned to a prefix that did not contain the finding.
it.each([false,true])("does not backdate H&S first qualification when later ATR expands (inverse=%s)",inverse=>{
 const source=hs();
 for(let i=25;i<=30;i++){const close=i<=28?99+(107-99)*(i-24)/4:107+(102-107)*(i-28)/2;source[i]={...source[i]!,open:close-.05,high:close+.2,low:close-.2,close};}
 const appended={...source.at(-1)!,time:START+33*300,closeTime:START+34*300,open:97,high:110,low:50,close:96};
 const all=inverse?inverted([...source,appended]):[...source,appended];const id=inverse?"inverse_head_and_shoulders":"head_and_shoulders";
 for(let end=30;end<=33;end++)expect(find(input(all.slice(0,end)),id)).toBeUndefined();
 const finding=find(input(all),id);expect(finding).toBeDefined();expect(finding?.status).toBe("confirmed");expect(finding?.confirmedAt).toBe(all[33]!.closeTime);
 const next={...all.at(-1)!,time:START+34*300,closeTime:START+35*300,open:inverse?124:96,high:inverse?125:96.5,low:inverse?123.5:95,close:inverse?124.5:95.5};
 expect(find(input([...all,next]),id)?.confirmedAt).toBe(all[33]!.closeTime);
 const cutoff=all[32]!.closeTime;expect(find(input(all,{replayCutoff:cutoff}),id)).toBeUndefined();
});


function doubleTopBars():SmartChartAnalysisBar[]{
 const points=[[0,90],[8,96],[12,105],[20,99],[28,105],[30,102],[31,98],[32,97]];
 return bars(rows(Array.from({length:33},(_,i)=>{const right=points.findIndex(p=>p[0]!>=i);if(right===0)return points[0]![1]!;const a=points[right-1]!,b=points[right]!;return a[1]!+(b[1]!-a[1]!)*(i-a[0]!)/(b[0]!-a[0]!);})));}

it.each([false,true])("keeps double reversal first confirmation and chronological geometry (inverse=%s)",inverse=>{
 const source=inverse?inverted(doubleTopBars()):doubleTopBars(),id=inverse?"double_bottom":"double_top";
 const developing=find(input(source.slice(0,31)),id),confirmed=find(input(source),id);
 expect(developing?.status).toBe("developing");expect(confirmed?.status).toBe("confirmed");
 expect(confirmed?.id).toBe(developing?.id);expect(confirmed?.confirmedAt).toBe(source[31]!.closeTime);
 expect(confirmed?.anchors.map(a=>a.time)).toEqual([source[12]!.time,source[20]!.time,source[28]!.time]);
 expect(find(input(source,{replayCutoff:source[30]!.closeTime}),id)?.confirmedAt).toBeUndefined();
 expect(find(input(source,{replayCutoff:source[31]!.closeTime}),id)?.confirmedAt).toBe(source[31]!.closeTime);
 const extended=bars([...doubleTopBars(),...rows([96,95])]);const more=inverse?inverted(extended):extended;
 expect(find(input(more),id)?.confirmedAt).toBe(source[31]!.closeTime);
});
it.each([false,true])("retains historical double reversal confirmation after invalidation (inverse=%s)",inverse=>{
 const base=doubleTopBars(),source=bars([...base,...rows([108,98])]),all=inverse?inverted(source):source,id=inverse?"double_bottom":"double_top";
 const f=find(input(all),id);expect(f?.status).toBe("invalidated");expect(f?.confirmedAt).toBe(all[31]!.closeTime);
});

it.each([false,true])("uses actual double-reversal pivot prices instead of rounded catalogue points (inverse=%s)",inverse=>{
 const raw=doubleTopBars().map(b=>({...b,open:b.open*1.000123,high:b.high*1.000123,low:b.low*1.000123,close:b.close*1.000123}));
 const b=inverse?inverted(raw):raw,f=find(input(b),inverse?"double_bottom":"double_top");expect(f).toBeDefined();
 expect(f?.anchors.map(a=>a.price)).toEqual([inverse?b[12]!.low:b[12]!.high,inverse?b[20]!.high:b[20]!.low,inverse?b[28]!.low:b[28]!.high]);
 expect(f?.levels[0]?.price).toBe(inverse?b[20]!.high:b[20]!.low);
});
