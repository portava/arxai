import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartAnalysisRenderer, studyDisplayWindow } from "./chartAnalysisRenderer";
import { HistogramSeries } from "lightweight-charts";
import { StudyCalculator, STUDY_DEFAULTS, STUDY_CATALOG, type ChartStudy } from "./chartStudies";

const SCALE_DEFAULTS = { mode: 0, autoScale: true, invertScale: false, alignLabels: true, borderVisible: true, scaleMargins: { top: .2, bottom: .1 } };
function fixture(count = 10000) {
  let range = { from: Math.max(0,count-200), to: count+10 } as any;
  let callback: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: () => void) => { scheduled = fn; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn(() => { scheduled = undefined; }));
  const handles: any[] = [];
  const scale = { getVisibleLogicalRange: () => range, setVisibleLogicalRange: vi.fn(), subscribeVisibleLogicalRangeChange: (fn: () => void) => { callback = fn; }, unsubscribeVisibleLogicalRangeChange: vi.fn() };
  // Pane model of lightweight-charts 5: a series index past the end appends
  // one pane, series draw in insertion order, and a pane left empty by
  // removeSeries is removed unless it preserves empty panes (pane 0 keeps the
  // price series).
  const chartOptions = { leftPriceScale: { ...SCALE_DEFAULTS, visible: false }, rightPriceScale: { ...SCALE_DEFAULTS, visible: true } };
  const newPane = (preserve = false) => ({ series: [] as any[], stretch: 1, preserve, scales: { left: structuredClone(chartOptions.leftPriceScale), right: structuredClone(chartOptions.rightPriceScale) } as Record<string, any> });
  const price: any = { name: "price" };
  const panes = [newPane()];
  panes[0]!.series.push(price);
  const paneOf = (series: any) => panes.find(pane => pane.series.includes(series))!;
  const chart = { timeScale: () => scale, options: () => chartOptions,
    priceScale: (id: string, pane = 0) => ({ options: () => panes[pane]!.scales[id] }),
    panes: () => panes.map(pane => ({ getSeries: () => [...pane.series], getStretchFactor: () => pane.stretch, setStretchFactor: (factor: number) => { pane.stretch = factor; } })),
    removeSeries: vi.fn((series: any) => {
      const pane = paneOf(series);
      pane.series.splice(pane.series.indexOf(series), 1);
      if (!pane.series.length && panes.length > 1 && !pane.preserve) panes.splice(panes.indexOf(pane), 1);
    }),
    addSeries: vi.fn((definition: any, options: any, paneIndex = 0) => {
    const line: any = { definition, options: { ...options }, priceLines: [] as any[], data: [] };
    line.createPriceLine = vi.fn((priceLine: any) => { line.priceLines.push(priceLine); });
    line.applyOptions = vi.fn((change: any) => { Object.assign(line.options, change); });
    line.setSeriesOrder = vi.fn((order: number) => {
      const list = paneOf(line).series;
      list.splice(list.indexOf(line), 1);
      list.splice(Math.max(0, Math.min(order, list.length)), 0, line);
    });
    line.setData=vi.fn((data:any[])=>{line.data=data.map(point=>({...point}));});
    line.update=vi.fn((point:any)=>{
      const last=line.data.at(-1);
      if(last && point.time<last.time)throw new Error("Historical update requires full replacement");
      if(last?.time===point.time)line.data[line.data.length-1]={...point};else line.data.push({...point});
    });
    line.pop=vi.fn((count:number)=>{
      // Actual LWC pop counts plotted values and leaves whitespace mappings.
      for(let i=line.data.length-1;i>=0&&count>0;i--)if(line.data[i].value!=null){line.data.splice(i,1);count--;}
    });
    const index = Math.min(panes.length, paneIndex);
    if (index === panes.length) panes.push(newPane());
    panes[index]!.series.push(line);
    handles.push(line); return line;
  }) };
  const renderer = new ChartAnalysisRenderer(chart as any, price);
  const candles = Array.from({ length: count }, (_, i) => ({ time: 100 + i * 60, open: 100, high: 120, low: 90, close: 100 + Math.sin(i / 4) }));
  return { renderer, candles, handles, chart, scale, panes, price, frame: () => scheduled?.(), move: (from: number, to: number) => { range = { from, to }; callback?.(); },
    /** chart.addPane(preserveEmptyPane) holding `series` (foreign, not studies). */
    addPane: (preserve: boolean, series: any[] = []) => { const pane = newPane(preserve); pane.series.push(...series); panes.push(pane); return pane; },
    /** Change the viewport without a library callback (as a later rebuild reads it). */
    view: (from: number, to: number) => { range = { from, to }; } };
}
afterEach(() => vi.unstubAllGlobals());
describe("study viewport rendering and streaming", () => {
  it("retains full calculations while limiting render geometry, and restores exact past values on pan", () => {
    const { renderer, handles, candles, move } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    expect(handles[0].setData.mock.calls[0][0]).toHaveLength(400);
    const historical = renderer.inspect(candles[1000]!.time)[0]!.values[0]!.value;
    expect(historical).toBeCloseTo(candles.slice(981, 1001).reduce((sum, bar) => sum + bar.close, 0) / 20, 9);
    move(1000, 1100);
    const data = handles[0].setData.mock.calls.at(-1)[0];
    expect(data[0].time).toBe(candles[800]!.time);
    expect(data.at(-1).time).toBe(candles[1300]!.time);
    expect(data.find((point: any) => point.time === candles[1000]!.time).value).toBeCloseTo(historical!, 10);
    move(1020, 1120);
    expect(handles[0].setData).toHaveBeenCalledTimes(2); // pan stays inside buffer
    move(0, 9999);
    expect(handles[0].setData.mock.calls.at(-1)[0]).toHaveLength(10000);
  });
  it("coalesces a stream burst but preserves every appended bar and the final revision", () => {
    const { renderer, handles, candles, frame } = fixture();
    const config = { ...STUDY_DEFAULTS[1]!, period: 3 };
    renderer.setStudies([config], candles);
    for (let i = 0; i < 10; i++) {
      candles[candles.length - 1] = { ...candles.at(-1)!, close: 105 + i / 10 };
      renderer.refreshLater(candles, candles.length - 1);
    }
    candles.push({ ...candles.at(-1)!, time: candles.at(-1)!.time + 60, close: 106 });
    renderer.refreshLater(candles, candles.length - 1);
    candles.push({ ...candles.at(-1)!, time: candles.at(-1)!.time + 60, close: 107 });
    renderer.refreshLater(candles, candles.length - 1);
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    frame();
    const expected = new StudyCalculator(config).calculate(candles);
    for (let i = 9999; i < candles.length; i++) expect(renderer.inspect(candles[i]!.time)[0]!.values[0]!.value).toBeCloseTo(expected[i]!.values[0]!, 10);
    const visible = handles[0].data;
    expect(visible.at(-1).time).toBe(candles.at(-1)!.time);
    expect(visible.at(-2).time).toBe(candles.at(-2)!.time);
  });
  it("updates historical calculations without pushing unseen streaming points into a past viewport", () => {
    const { renderer, handles, candles, frame, move } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    move(1000, 1100);
    candles[candles.length - 1] = { ...candles.at(-1)!, close: 109 };
    renderer.refreshLater(candles, 9999); frame();
    expect(handles[0].update).not.toHaveBeenCalled();
    move(9800, 10010);
    expect(handles[0].setData.mock.calls.at(-1)[0].at(-1).value).toBeCloseTo(renderer.inspect(candles.at(-1)!.time)[0]!.values[0]!.value!, 10);
  });
  it("cancels queued work when destroyed and rebuilds corrected snapshots", () => {
    const { renderer, handles, candles, frame, scale } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    renderer.refreshLater(candles, 9999);
    const corrected = candles.slice(-500).map(bar => ({ ...bar, close: 111 }));
    renderer.refresh(corrected, 0, true); frame();
    expect(renderer.inspect(corrected.at(-1)!.time)[0]!.values[0]!.value).toBe(111);
    renderer.refreshLater(corrected, 499);
    renderer.destroy(); frame();
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(scale.unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(1);
  });
  it("batches intermediate price-axis movement and renders only the final study window", () => {
    const {renderer,handles,candles,move}=fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0,1),candles);
    handles[0].setData.mockClear();
    renderer.batchViewport(()=>{
      move(0,10);move(4000,4100);
      renderer.refresh(candles,9999,true);
    });
    expect(handles[0].setData).toHaveBeenCalledTimes(1);
    const rendered=handles[0].setData.mock.calls[0][0];
    expect(rendered[0].time).toBe(candles[3800]!.time);
    expect(rendered.at(-1).time).toBe(candles[4300]!.time);
    move(9000,9100);expect(handles[0].setData).toHaveBeenCalledTimes(2);
  });
  it("bounds windows at empty, first, last and out-of-range views", () => {
    expect(studyDisplayWindow(0, null, null)).toEqual({ from: 0, to: 0 });
    expect(studyDisplayWindow(10000, { from: -100, to: 100 } as any, null)).toEqual({ from: 0, to: 301 });
    expect(studyDisplayWindow(10000, { from: 9900, to: 11000 } as any, null)).toEqual({ from: 9700, to: 10000 });
    expect(studyDisplayWindow(10, null, null)).toEqual({ from: 0, to: 10 });
  });
});


describe("exact study tail reconciliation",()=>{
  for(const {defaults:config} of STUDY_CATALOG) it(`${config.kind}: all rendered channels equal a full calculation through replay and corrections`,()=>{
    const f=fixture(320);let bars=f.candles;
    f.renderer.setStudies([config],bars);
    const verify=()=>{
      const expected=new StudyCalculator(config).calculate(bars);
      for(const [channel,line] of f.handles.entries()) {
        const visible=expected.filter(point=>point.time>=line.data[0]?.time&&point.time<=line.data.at(-1)?.time);
        expect(line.data).toEqual(visible.map(point=>{
          const value=point.values[channel];
          return value==null||!Number.isFinite(value)?{time:point.time}:{time:point.time,value,
            ...(config.kind==='macd'&&channel===2?{color:value>=0?'#10b981':'#ef4444'}:{})};
        }));
        expect(line.data.length).toBe(bars.length); // full visible fixture, including whitespace
      }
    };
    verify();const original=bars;
    for(const count of [319,320,288,320,1,2,Math.max(1,config.period-1),config.period,config.period+1,320]){
      bars=original.slice(0,count);f.renderer.batchViewport(()=>{f.move(0,count+10);f.renderer.refresh(bars,0,false);});verify();
    }
    expect(f.handles.every(line=>line.pop.mock.calls.length>0)).toBe(true);
    bars=bars.map((bar,i)=>i===319?{...bar,close:105}:bar);f.renderer.refresh(bars,319,false);verify();
    bars=bars.map((bar,i)=>i===180?{...bar,close:107}:bar);f.renderer.refresh(bars,180,true);verify();
    bars=[{...bars[0]!,time:40},...bars];f.renderer.refresh(bars,0,true);verify();
    bars=[];f.renderer.refresh(bars,0,true);verify();
    bars=original.slice(0,1);f.renderer.refresh(bars,0,true);verify();
    bars=original;f.renderer.refresh(bars,0,true);verify();
    // A changed period/config recalculates that study from scratch and replaces
    // its rendered data on the existing series (no stale values remain).
    const altered={...config,period:Math.max(2,config.period+1)};
    const series=f.chart.addSeries.mock.calls.length;
    f.renderer.setStudies([altered],bars);
    expect(f.chart.addSeries).toHaveBeenCalledTimes(series); // edited in place
    expect(f.chart.removeSeries).not.toHaveBeenCalled();
    const last=f.handles.at(-1).data.at(-1);
    const values=new StudyCalculator(altered).calculate(bars).at(-1)!.values;
    expect(last.value??null).toBe(values.at(-1)??null);
  });
  it("uses tail writes for adjacent bars without shifting the buffer, and rebuilds on actual viewport changes",()=>{
    const f=fixture();f.renderer.setStudies(STUDY_DEFAULTS.slice(0,2),f.candles);
    const start=f.handles[0].data[0].time;
    for(const n of [9999,10000])f.renderer.batchViewport(()=>{
      f.move(n-150,n+10);f.renderer.refresh(f.candles.slice(0,n),9999,false);
    });
    for(const line of f.handles){expect(line.setData).toHaveBeenCalledTimes(1);expect(line.pop).toHaveBeenCalledWith(1);expect(line.update).toHaveBeenCalledTimes(1);expect(line.data[0].time).toBe(start);}
    f.move(1000,1100);expect(f.handles[0].setData).toHaveBeenCalledTimes(2);
    f.move(0,9999);expect(f.handles[0].data).toHaveLength(10000);
  });
});

/** Everything a study change leaves in the chart: panes in order, each
 * series in draw order with its type, options, price lines and data, the
 * pane proportions and price scales, plus the inspected study values. */
function chartState(f: ReturnType<typeof fixture>, times: number[]) {
  return {
    panes: f.panes.map(pane => ({
      stretch: pane.stretch, preserve: pane.preserve, scales: pane.scales,
      series: pane.series.map((series: any) => series.definition === undefined ? series.name : {
        type: series.definition === HistogramSeries ? "histogram" : "line",
        options: Object.fromEntries(Object.entries(series.options).map(([key, value]) => [key, typeof value === "function" ? (value as () => unknown)() : value])),
        priceLines: series.priceLines, data: series.data,
      }),
    })),
    inspect: times.map(time => f.renderer.inspect(time)),
  };
}
const OTHER = { sma: { id: "a", kind: "sma", period: 9, color: "#111111" }, rsi: { id: "b", kind: "rsi", period: 7, color: "#222222" }, stochastic: { id: "s", kind: "stochastic", period: 5, smoothing: 2, signal: 3, color: "#333333" } } as const satisfies Record<string, ChartStudy>;
/** A parameter edit other than period for each kind (source, method, multiplier, signal...). */
function parameterEdit(study: ChartStudy): ChartStudy {
  switch (study.kind) {
    case "bollinger": case "envelopes": return { ...study, multiplier: (study.multiplier ?? 2) + .5, ...(study.kind === "envelopes" ? { method: "ema" } : {}) };
    case "atr": return { ...study, method: "wma" };
    case "macd": return { ...study, signal: 4, signalMethod: "sma", slow: 30 };
    case "stochastic": return { ...study, smoothing: 4, signal: 2 };
    case "williams": return { ...study, period: study.period + 3 };
    default: return { ...study, source: "hl2" };
  }
}

describe("incremental study changes equal a full rebuild", () => {
  const COUNT = 1500;
  const times = (candles: { time: number }[]) => [0, 40, 700, 1100, candles.length - 2, candles.length - 1].map(i => candles[i]!.time);
  /** Apply each step to one renderer incrementally and compare every step
   * against a fresh renderer that builds the same studies from nothing. */
  function compare(steps: ChartStudy[][], options: { foreign?: boolean; between?: (f: ReturnType<typeof fixture>) => void; fresh?: (f: ReturnType<typeof fixture>) => void } = {}) {
    const live = fixture(COUNT);
    live.move(1000, 1100);
    live.renderer.setStudies(steps[0]!, live.candles);
    // A series added after the studies (a restyled price series or structure
    // line) is drawn under rebuilt studies, so patched studies must be too.
    if (options.foreign !== false) live.panes[0]!.series.push({ name: "foreign" });
    const results: { added: number; removed: any[]; options: number }[] = [];
    for (const step of steps.slice(1)) {
      options.between?.(live);
      // Inside the pan buffer: the stale window differs from a rebuild's.
      live.view(1020, 1120);
      const added = live.chart.addSeries.mock.calls.length;
      live.chart.removeSeries.mockClear();
      const applied = live.handles.reduce((sum, line) => sum + line.applyOptions.mock.calls.length, 0);
      live.renderer.setStudies(step, live.candles);
      const fresh = fixture(COUNT);
      fresh.candles.splice(0, fresh.candles.length, ...live.candles);
      if (options.foreign !== false) fresh.panes[0]!.series.push({ name: "foreign" });
      // Foreign panes or series the live chart gained, before any study exists.
      options.fresh?.(fresh);
      fresh.view(1020, 1120);
      fresh.renderer.setStudies(step, fresh.candles);
      expect(chartState(live, times(live.candles))).toEqual(chartState(fresh, times(fresh.candles)));
      results.push({ added: live.chart.addSeries.mock.calls.length - added, removed: live.chart.removeSeries.mock.calls.map(call => call[0]),
        options: live.handles.reduce((sum, line) => sum + line.applyOptions.mock.calls.length, 0) - applied });
    }
    return { live, results };
  }
  const channels = (study: ChartStudy) => STUDY_CATALOG.find(item => item.defaults.kind === study.kind)!.channels.length;

  for (const { defaults } of STUDY_CATALOG) {
    const k: ChartStudy = { ...defaults, id: "k" };
    describe(k.kind, () => {
      it("append keeps every existing series and only adds the new study", () => {
        const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, k]]);
        expect(results[0]).toEqual({ added: channels(k), removed: [], options: 0 });
      });
      it("remove deletes only that study's series and renumbers later panes", () => {
        const { live, results } = compare([[OTHER.sma, k, OTHER.rsi], [OTHER.sma, OTHER.rsi]]);
        expect(results[0]!.added).toBe(0);
        expect(results[0]!.removed).toHaveLength(channels(k));
        expect(live.panes).toHaveLength(2);
      });
      it("period change recalculates in place", () => {
        const { results } = compare([[OTHER.sma, k, OTHER.rsi], [OTHER.sma, { ...k, period: k.period + 1 }, OTHER.rsi]]);
        expect(results[0]).toMatchObject({ added: 0, removed: [] });
        // Oscillator titles carry the period; overlays have no title.
        expect(results[0]!.options).toBe(STUDY_CATALOG.find(item => item.defaults.kind === k.kind)!.pane ? channels(k) - (k.kind === "macd" ? 1 : 0) : 0);
      });
      it("colour change updates options in place", () => {
        const { results } = compare([[OTHER.sma, k, OTHER.rsi], [OTHER.sma, { ...k, color: "#123456" }, OTHER.rsi]]);
        expect(results[0]).toMatchObject({ added: 0, removed: [] });
        expect(results[0]!.options).toBeGreaterThan(0);
      });
      it("source, method, multiplier and signal edits recalculate in place", () => {
        const { results } = compare([[OTHER.sma, k, OTHER.rsi], [OTHER.sma, parameterEdit(k), OTHER.rsi]]);
        // Only williams' edit changes the period in its title; no other option
        // (the kind-fixed autoscale range included) is re-applied.
        expect(results[0]).toEqual({ added: 0, removed: [], options: k.kind === "williams" ? channels(k) : 0 });
      });
      it("reorder falls back to the full rebuild", () => {
        const { results } = compare([[OTHER.sma, k, OTHER.rsi], [OTHER.rsi, k, OTHER.sma]]);
        expect(results[0]!.removed).toHaveLength(1 + channels(k) + 1);
        expect(results[0]!.added).toBe(1 + channels(k) + 1);
      });
      it("pane-count changes add and remove oscillator panes like a rebuild", () => {
        // Add a pane, remove a middle pane (stochastic moves up), append a pane
        // again, then remove two panes at once.
        const { live, results } = compare([[k, OTHER.rsi], [k, OTHER.rsi, OTHER.stochastic], [k, OTHER.stochastic], [k, OTHER.stochastic, OTHER.rsi], [k]]);
        const panes = STUDY_CATALOG.find(item => item.defaults.kind === k.kind)!.pane ? 1 : 0;
        expect(results.map(result => result.added)).toEqual([2, 0, 1, 0]);
        expect(results.map(result => result.removed.length)).toEqual([0, 1, 0, 3]);
        expect(live.panes).toHaveLength(1 + panes);
      });
    });
  }

  it("matches by position and kind when studies have no id", () => {
    const sma = { kind: "sma", period: 9, color: "#111111" } as ChartStudy, rsi = { kind: "rsi", period: 7, color: "#222222" } as ChartStudy, macd = STUDY_DEFAULTS[4]!;
    const { results } = compare([[sma, rsi], [sma, { ...rsi, period: 8 }], [sma, { ...rsi, period: 8 }, macd], [sma, macd], [macd, sma]]);
    expect(results[0]).toMatchObject({ added: 0, removed: [] });
    expect(results[1]).toMatchObject({ added: 3, removed: [] });
    // Removing rsi shifts macd to index 1: it is a different position, so
    // rsi and macd are replaced while sma at index 0 is kept.
    expect(results[2]!.added).toBe(3);
    expect(results[2]!.removed).toHaveLength(4);
    // Nothing keeps its position and kind: full rebuild.
    expect(results[3]!.removed).toHaveLength(4);
  });
  it("brings kept studies up to date with changed, appended and queued bars", () => {
    const { live } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, { ...OTHER.rsi, color: "#abcdef" }, OTHER.stochastic], [OTHER.sma, OTHER.stochastic]], {
      between: f => {
        // An in-place correction of an old bar, a revised last bar, a new bar,
        // and a queued stream revision the study change must not lose.
        (f.candles[300] as any).close = 140;
        f.candles[f.candles.length - 1] = { ...f.candles.at(-1)!, close: 99 };
        f.candles.push({ ...f.candles.at(-1)!, time: f.candles.at(-1)!.time + 60, close: 101 });
        f.renderer.refreshLater(f.candles, f.candles.length - 1);
      },
    });
    expect(live.renderer.inspect(live.candles[300]!.time)[0]!.values[0]!.value)
      .toBe(new StudyCalculator(OTHER.sma).calculate(live.candles)[300]!.values[0]);
  });
  it("recalculates kept studies from bars they consumed that the new candles no longer have", () => {
    compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      // A correction refreshed into the studies, then a candle set without it.
      between: f => { f.renderer.refresh(f.candles.map((bar, i) => i === 500 ? { ...bar, close: 150 } : bar), 500, false); },
    });
    // A patch records its inputs; a later refresh must record the corrected
    // bar it consumed, so the next patch sees the reverted candles as changed.
    let n = 0;
    compare([[OTHER.sma], [OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      between: f => { if (n++ === 1) f.renderer.refresh(f.candles.map((bar, i) => i === 500 ? { ...bar, close: 150 } : bar), 500, false); },
    });
  });
  it("detects high-, low- and open-only corrections of an old bar for kept studies that read them", () => {
    const kept: ChartStudy[] = [
      { id: "t", kind: "atr", period: 5, method: "smma", color: "#444444" }, OTHER.stochastic,
      { id: "w", kind: "williams", period: 5, color: "#555555" },
      { id: "h", kind: "sma", period: 5, source: "hl2", color: "#666666" },
      { id: "o", kind: "sma", period: 5, source: "open", color: "#777777" },
    ];
    // Each correction is inside the rendered window and leaves close alone.
    const corrections = [(bar: any) => ({ ...bar, high: 131 }), (bar: any) => ({ ...bar, low: 81 }), (bar: any) => ({ ...bar, open: 104 })];
    let n = 0;
    const { results } = compare([kept, [...kept, OTHER.rsi], kept, [...kept, OTHER.rsi]], {
      between: f => { const i = 1050 + 3 * n; f.candles[i] = corrections[n++]!(f.candles[i]); },
    });
    // Every step patched: only the toggled rsi is added or removed.
    expect(results.map(result => [result.added, result.removed.length])).toEqual([[1, 0], [0, 1], [1, 0]]);
  });
  it("recalculates only added or edited studies, and kept studies only from the first changed bar", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    const calculate = StudyCalculator.prototype.calculate;
    const calls: { id?: string; from: number; start: number }[] = [];
    const spy = vi.spyOn(StudyCalculator.prototype, "calculate").mockImplementation(function (this: StudyCalculator, bars, from = 0, collect = true) {
      // start: the first bar the calculator actually recalculates.
      calls.push({ id: this.config.id, from, start: Math.min(from, this.points.length, bars.length) });
      return calculate.call(this, bars, from, collect);
    });
    const step = (studies: ChartStudy[]) => { calls.length = 0; f.renderer.setStudies(studies, f.candles); return calls; };
    const next = (close: number) => ({ ...f.candles.at(-1)!, time: f.candles.at(-1)!.time + 60, close });
    try {
      const smaPoints = (f.renderer as any).studies[0].calculator.points;
      const early = smaPoints[600];
      // An appended bar: kept studies continue from it, the new one starts at 0.
      f.candles.push(next(101));
      expect(step([OTHER.sma, OTHER.rsi, OTHER.stochastic])).toEqual([{ id: "a", from: COUNT, start: COUNT }, { id: "b", from: COUNT, start: COUNT }, { id: "s", from: COUNT, start: 0 }]);
      // Unchanged bars since that patch: kept studies have nothing to recalculate.
      const rsi9 = { ...OTHER.rsi, period: 9 };
      expect(step([OTHER.sma, rsi9, OTHER.stochastic])).toEqual([{ id: "a", from: COUNT + 1, start: COUNT + 1 }, { id: "b", from: COUNT + 1, start: 0 }, { id: "s", from: COUNT + 1, start: COUNT + 1 }]);
      // A colour edit recalculates that study but re-renders nothing unchanged.
      const rendered = f.handles.map(line => line.setData.mock.calls.length);
      const stochastic = { ...OTHER.stochastic, color: "#343434" };
      expect(step([OTHER.sma, rsi9, stochastic])).toEqual([{ id: "a", from: COUNT + 1, start: COUNT + 1 }, { id: "b", from: COUNT + 1, start: COUNT + 1 }, { id: "s", from: COUNT + 1, start: 0 }]);
      expect(f.handles.map(line => line.setData.mock.calls.length)).toEqual(rendered);
      // Bars appended and refreshed from their last index only: the refresh
      // records every bar the calculators consumed.
      f.candles.push(next(102), next(103), next(104));
      f.renderer.refresh(f.candles, f.candles.length - 1, false);
      const length = f.candles.length;
      expect(step([OTHER.sma, { ...rsi9, color: "#232323" }, stochastic])).toEqual([{ id: "a", from: length, start: length }, { id: "b", from: length, start: 0 }, { id: "s", from: length, start: length }]);
      // A corrected old bar plus an appended bar, and an rsi edit.
      f.candles[700] = { ...f.candles[700]!, close: 140 };
      f.candles.push(next(105));
      expect(step([OTHER.sma, rsi9, stochastic])).toEqual([{ id: "a", from: 700, start: 700 }, { id: "b", from: 700, start: 0 }, { id: "s", from: 700, start: 700 }]);
      // The kept calculator kept its points before the first changed bar.
      expect((f.renderer as any).studies[0].calculator.points).toBe(smaPoints);
      expect(smaPoints[600]).toBe(early);
    } finally { spy.mockRestore(); }
    const fresh = fixture(COUNT);
    fresh.candles.splice(0, fresh.candles.length, ...f.candles);
    fresh.renderer.setStudies([OTHER.sma, { ...OTHER.rsi, period: 9 }, { ...OTHER.stochastic, color: "#343434" }], fresh.candles);
    expect(chartState(f, times(f.candles))).toEqual(chartState(fresh, times(fresh.candles)));
  });
  it("re-windows kept series to the window a rebuild chooses", () => {
    const { live } = compare([[OTHER.sma], [OTHER.sma, OTHER.rsi]], { foreign: false });
    expect(live.handles[0].data[0].time).toBe(live.candles[820]!.time);
    expect(live.handles[0].setData).toHaveBeenCalledTimes(2);
    // The kept overlay already draws last in pane 0: no reorder call.
    expect(live.handles.every(line => line.setSeriesOrder.mock.calls.length === 0)).toBe(true);
  });
  // Without a pan the edited study's window is unchanged, so only a full value
  // comparison can tell that a later channel (bands, signal, %D) moved while the
  // first channel (basis, MACD, %K) did not.
  for (const edit of [
    { ...OTHER.sma, id: "e", kind: "bollinger", multiplier: 2 } as ChartStudy,
    { ...OTHER.sma, id: "e", kind: "envelopes", multiplier: 1, method: "sma" } as ChartStudy,
    { id: "e", kind: "macd", period: 12, slow: 26, signal: 9, color: "#2dd4bf" } as ChartStudy,
    { id: "e", kind: "stochastic", period: 14, smoothing: 3, signal: 3, color: "#2dd4bf" } as ChartStudy,
  ]) it(`re-renders ${edit.kind} channels whose values changed while the first channel did not, without a pan`, () => {
    const changed: ChartStudy = edit.kind === "macd" || edit.kind === "stochastic" ? { ...edit, signal: (edit.signal ?? 3) + 2 } : { ...edit, multiplier: (edit.multiplier ?? 1) + 1 };
    const live = fixture(COUNT);
    live.renderer.setStudies([OTHER.sma, edit], live.candles);
    live.chart.removeSeries.mockClear();
    live.renderer.setStudies([OTHER.sma, changed], live.candles);
    expect(live.chart.removeSeries).not.toHaveBeenCalled();
    const fresh = fixture(COUNT);
    fresh.renderer.setStudies([OTHER.sma, changed], fresh.candles);
    expect(chartState(live, times(live.candles))).toEqual(chartState(fresh, times(fresh.candles)));
  });
  it("skips setData for kept series whose window and values are unchanged", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi, OTHER.stochastic], f.candles);
    expect(f.handles[0].setData).toHaveBeenCalledTimes(1);
    expect(f.handles[1].setData).toHaveBeenCalledTimes(1);
    expect(f.handles.slice(2).every(line => line.setData.mock.calls.length === 1)).toBe(true);
  });
  for (const side of ["left", "right"] as const) for (const [option, value] of [["autoScale", false], ["mode", 1]] as const) {
    it(`rebuilds when a kept oscillator pane's ${side} scale ${option} was changed by hand, resetting it`, () => {
      const { live, results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, { ...OTHER.rsi, period: 9 }]], {
        between: f => { f.panes[1]!.scales[side][option] = value; },
      });
      expect(results[0]!.removed).toHaveLength(2);
      expect(live.panes[1]!.scales[side][option]).toBe(SCALE_DEFAULTS[option]);
    });
    // Every kept oscillator pane is checked, not only the first: here the
    // edited rsi's pane is untouched and the untouched stochastic's was scaled.
    it(`rebuilds when the second kept oscillator pane's ${side} scale ${option} was changed by hand, resetting it`, () => {
      const { live, results } = compare([[OTHER.sma, OTHER.rsi, OTHER.stochastic], [OTHER.sma, { ...OTHER.rsi, period: 9 }, OTHER.stochastic]], {
        between: f => { f.panes[2]!.scales[side][option] = value; },
      });
      expect(results[0]!.removed).toHaveLength(1 + 1 + 2);
      expect(live.panes[2]!.scales[side][option]).toBe(SCALE_DEFAULTS[option]);
    });
  }
  // Unexpected panes take the full rebuild before anything is patched. Each
  // live setup is mirrored in the fresh renderer as it stood before studies.
  it("rebuilds when an oscillator pane also holds a foreign series", () => {
    const foreign = { name: "foreign-osc" };
    const { live, results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      between: f => { f.panes[1]!.series.push(foreign); },
      fresh: f => { f.addPane(false, [{ name: "foreign-osc" }]); },
    });
    expect(results[0]).toEqual({ added: 4, removed: [live.handles[1], live.handles[0]], options: 0 });
    expect(live.panes[1]!.series[0]).toBe(foreign);
  });
  it("rebuilds when the chart has an extra preserved empty pane", () => {
    const { live, results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      between: f => { f.addPane(true); },
      fresh: f => { f.addPane(true); },
    });
    expect(results[0]).toEqual({ added: 4, removed: [live.handles[1], live.handles[0]], options: 0 });
    expect(live.panes.map(pane => pane.preserve)).toEqual([false, true, false]);
  });
  it("rebuilds when removing a study leaves its preserved pane empty after the last oscillator", () => {
    const { live, results } = compare([[OTHER.sma, OTHER.rsi, OTHER.stochastic], [OTHER.sma, OTHER.rsi]], {
      between: f => { f.panes[2]!.preserve = true; f.scale.setVisibleLogicalRange.mockClear(); },
      fresh: f => { f.addPane(true); },
    });
    // The patch removed stochastic; the left-over pane then forced the rebuild.
    expect(results[0]!.removed).toHaveLength(2 + 2);
    expect(results[0]!.added).toBe(2);
    expect(live.panes).toHaveLength(2);
    // That fallback rebuild restores the viewport read before the patch began.
    expect(live.scale.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(live.scale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1020, to: 1120 });
  });
  it("rebuilds when removing a study leaves a preserved pane empty before a kept oscillator", () => {
    const cci: ChartStudy = { id: "c", kind: "cci", period: 6, color: "#888888" };
    const { live, results } = compare([[OTHER.sma, OTHER.rsi, OTHER.stochastic], [OTHER.sma, OTHER.stochastic, cci]], {
      between: f => { f.panes[1]!.preserve = true; f.scale.setVisibleLogicalRange.mockClear(); },
      fresh: f => { f.addPane(true); },
    });
    // The patch removed rsi and added cci into the stochastic pane; the
    // layout check then forced the rebuild.
    expect(results[0]!.removed).toHaveLength(1 + 1 + 2 + 1);
    expect(results[0]!.added).toBe(1 + 1 + 2 + 1);
    expect(live.panes.map(pane => pane.series.length)).toEqual([3, 2, 1]);
    expect(live.scale.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(live.scale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1020, to: 1120 });
  });
  it("replaces a study whose id is kept but whose kind changed", () => {
    const k: ChartStudy = { id: "k", kind: "sma", period: 5, color: "#999999" };
    const { live, results } = compare([[OTHER.sma, k], [OTHER.sma, { ...STUDY_DEFAULTS[4]!, id: "k" }], [OTHER.sma, { ...STUDY_DEFAULTS[1]!, id: "k" }]]);
    expect(results[0]).toEqual({ added: 3, removed: [live.handles[1]], options: 0 });
    expect(results[1]).toEqual({ added: 1, removed: live.handles.slice(2, 5), options: 0 });
  });
  it("resets hand-resized pane proportions exactly as a rebuild does", () => {
    compare([[OTHER.sma, OTHER.rsi, OTHER.stochastic], [OTHER.sma, { ...OTHER.rsi, period: 10 }, OTHER.stochastic]], {
      between: f => { f.panes[0]!.stretch = 7; f.panes[1]!.stretch = .25; f.panes[2]!.stretch = 2; },
    });
  });
  it("falls back to the full rebuild when a study is inserted before a kept study", () => {
    const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, STUDY_DEFAULTS[4]!, OTHER.rsi], [{ ...STUDY_DEFAULTS[1]!, id: "e" }, OTHER.sma, STUDY_DEFAULTS[4]!, OTHER.rsi]]);
    expect(results.map(result => result.removed.length)).toEqual([2, 5]);
    expect(results.map(result => result.added)).toEqual([5, 6]);
  });
  it("restores the visible range and leaves no queued frame", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma], f.candles);
    f.renderer.refreshLater(f.candles, COUNT - 1);
    // Model the library: setting the range moves the viewport, and adding a
    // series in a new pane may move it too.
    f.scale.setVisibleLogicalRange.mockClear().mockImplementation((range: any) => f.view(range.from, range.to));
    vi.mocked(cancelAnimationFrame).mockClear();
    const addSeries = f.chart.addSeries.getMockImplementation()!;
    f.chart.addSeries.mockImplementation((...args: any[]) => { f.view(0, 50); return (addSeries as (...a: any[]) => any)(...args); });
    const before = { ...f.scale.getVisibleLogicalRange() };
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    expect(f.chart.removeSeries).not.toHaveBeenCalled(); // the patch path
    expect(f.chart.addSeries).toHaveBeenCalledTimes(2);
    expect(f.scale.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(f.scale.setVisibleLogicalRange).toHaveBeenCalledWith(before);
    expect(f.scale.getVisibleLogicalRange()).toEqual(before);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    const rendered = f.handles.map(line => line.setData.mock.calls.length);
    f.frame();
    expect(f.handles.map(line => line.setData.mock.calls.length)).toEqual(rendered);
    // The kept series are windowed like a rebuild's, which renders against
    // the viewport the added series left, before the range is restored.
    const fresh = fixture(COUNT);
    fresh.view(before.from, before.to);
    fresh.scale.setVisibleLogicalRange.mockImplementation((range: any) => fresh.view(range.from, range.to));
    const freshAdd = fresh.chart.addSeries.getMockImplementation()!;
    fresh.chart.addSeries.mockImplementation((...args: any[]) => { fresh.view(0, 50); return (freshAdd as (...a: any[]) => any)(...args); });
    fresh.renderer.setStudies([OTHER.sma, OTHER.rsi], fresh.candles);
    expect(chartState(f, times(f.candles))).toEqual(chartState(fresh, times(fresh.candles)));
  });
  it("detects a time-only change of bars the kept studies consumed", () => {
    const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      // Bars from 1050 on move 30s later; open, high, low and close stay.
      between: f => { for (let i = 1050; i < f.candles.length; i++) f.candles[i] = { ...f.candles[i]!, time: f.candles[i]!.time + 30 }; },
    });
    expect(results[0]).toEqual({ added: 2, removed: [], options: 0 });
  });
  it("detects a correction of bar 0 for a kept study that remembers its whole history", () => {
    // rsi's smoothing carries bar 0 into every later value of the window.
    const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      between: f => { f.candles[0] = { ...f.candles[0]!, close: 130, high: 140 }; },
    });
    expect(results[0]).toEqual({ added: 2, removed: [], options: 0 });
  });
  it("records a corrected old bar a patch consumed, so a later revert is seen", () => {
    // The live candles never pass through refresh(): only the patches read
    // the correction of bar 700 and then its revert.
    let n = 0, original: any;
    const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic], [OTHER.sma, OTHER.rsi]], {
      between: f => {
        if (n++ === 0) { original = f.candles[700]; f.candles[700] = { ...original, close: 140 }; } else f.candles[700] = original;
      },
    });
    expect(results.map(result => [result.added, result.removed.length])).toEqual([[2, 0], [0, 2]]);
  });
  it("a stream refresh after a patch renders the window a rebuild would", () => {
    // The patch re-windows to the rebuild's window; a later tail refresh must
    // continue from that window, not the one before the patch.
    const step = [OTHER.sma, OTHER.rsi, OTHER.stochastic];
    const { live, results } = compare([[OTHER.sma, OTHER.rsi], step]);
    expect(results[0]!.removed).toEqual([]);
    const fresh = fixture(COUNT);
    fresh.panes[0]!.series.push({ name: "foreign" });
    fresh.view(1020, 1120);
    fresh.renderer.setStudies(step, fresh.candles);
    for (const f of [live, fresh]) {
      f.candles[COUNT - 1] = { ...f.candles[COUNT - 1]!, close: 97 };
      f.renderer.refresh(f.candles, COUNT - 1, false);
    }
    expect(chartState(live, times(live.candles))).toEqual(chartState(fresh, times(fresh.candles)));
  });
  it("renders a queued revision of the last rendered bar into kept series when the studies change", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    // The live tail is in view; the revision is still waiting for its frame.
    f.candles[COUNT - 1] = { ...f.candles[COUNT - 1]!, close: 97 };
    f.renderer.refreshLater(f.candles, COUNT - 1);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi, OTHER.stochastic], f.candles);
    expect(f.chart.removeSeries).not.toHaveBeenCalled(); // the patch path
    const fresh = fixture(COUNT);
    fresh.candles.splice(0, COUNT, ...f.candles);
    fresh.renderer.setStudies([OTHER.sma, OTHER.rsi, OTHER.stochastic], fresh.candles);
    expect(f.handles[0].data.at(-1).time).toBe(f.candles[COUNT - 1]!.time);
    expect(chartState(f, times(f.candles))).toEqual(chartState(fresh, times(fresh.candles)));
  });
  it("records the bars a refresh consumed from a coalesced earlier queued revision", () => {
    const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      // A queued revision of bar 1050, then a synchronous refresh from the
      // last bar that coalesces it; the live candles keep the original bar,
      // so the patch must see bar 1050 as reverted.
      between: f => {
        const changed = f.candles.map((bar, i) => i === 1050 ? { ...bar, close: 150 } : bar);
        f.renderer.refreshLater(changed, 1050);
        f.renderer.refresh(changed, changed.length - 1, false);
      },
    });
    expect(results[0]).toEqual({ added: 2, removed: [], options: 0 });
  });
  it("records the inputs again after the candles shrink and regrow with different bars", () => {
    const { results } = compare([[OTHER.sma, OTHER.rsi], [OTHER.sma, OTHER.rsi, OTHER.stochastic]], {
      // A seek back to 1400 bars, then 100 different bars refreshed from the
      // last index only; the live candles keep the original 1500 bars.
      between: f => {
        f.renderer.refresh(f.candles.slice(0, 1400), 1399, false);
        f.renderer.refresh(f.candles.map((bar, i) => i >= 1400 ? { ...bar, close: 130 } : bar), COUNT - 1, false);
      },
    });
    expect(results[0]).toEqual({ added: 2, removed: [], options: 0 });
  });
  it("ignores a range callback fired while the patch removes and adds series", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    const removed = f.handles[1];
    // LWC fires the logical range callback synchronously when a series change
    // moves the viewport.
    const addSeries = f.chart.addSeries.getMockImplementation()!;
    f.chart.addSeries.mockImplementation((...args: any[]) => { f.move(0, 50); return (addSeries as (...a: any[]) => any)(...args); });
    removed.setData.mockClear();
    f.renderer.setStudies([OTHER.sma, OTHER.stochastic], f.candles);
    expect(f.chart.removeSeries).toHaveBeenCalledTimes(1);
    expect(f.chart.removeSeries).toHaveBeenCalledWith(removed);
    expect(removed.setData).not.toHaveBeenCalled();
  });
  it("ignores a range callback fired while the patch renders, and renders the next one", () => {
    const f = fixture(COUNT);
    f.move(1000, 1100);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    const sma = f.handles[0];
    const setData = sma.setData.getMockImplementation()!;
    let fired = false;
    sma.setData.mockImplementation((data: any[]) => { setData(data); if (!fired) { fired = true; f.move(100, 200); } });
    f.view(1020, 1120);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi, OTHER.stochastic], f.candles);
    expect(f.chart.removeSeries).not.toHaveBeenCalled();
    expect(fired).toBe(true);
    // The library notifies the final viewport again once the patch is done.
    f.move(100, 200);
    const fresh = fixture(COUNT);
    fresh.view(100, 200);
    fresh.renderer.setStudies([OTHER.sma, OTHER.rsi, OTHER.stochastic], fresh.candles);
    expect(chartState(f, times(f.candles))).toEqual(chartState(fresh, times(fresh.candles)));
  });
  it("still patches when the removed study's own pane was scaled by hand", () => {
    const { live, results } = compare([[OTHER.sma, OTHER.rsi, OTHER.stochastic], [OTHER.sma, OTHER.rsi]], {
      between: f => { f.panes[2]!.scales.right.autoScale = false; },
    });
    expect(results[0]).toEqual({ added: 0, removed: live.handles.slice(2, 4), options: 0 });
  });
  it("does nothing when the studies are unchanged", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    f.renderer.refreshLater(f.candles, COUNT - 1);
    f.scale.setVisibleLogicalRange.mockClear();
    vi.mocked(cancelAnimationFrame).mockClear();
    const rendered = f.handles.map(line => line.setData.mock.calls.length);
    f.renderer.setStudies([{ ...OTHER.sma }, { ...OTHER.rsi }], f.candles);
    expect(f.scale.setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    expect(f.handles.map(line => line.setData.mock.calls.length)).toEqual(rendered);
    expect(f.chart.addSeries).toHaveBeenCalledTimes(2);
    expect(f.chart.removeSeries).not.toHaveBeenCalled();
  });
  /** Wraps the renderer's record of consumed bar inputs (5 numbers per bar)
   * and collects the bar index of every recorded value it writes. */
  function watchRecordedInputs(renderer: ChartAnalysisRenderer) {
    const target = (renderer as any).inputs as number[];
    expect(Array.isArray(target)).toBe(true);
    const written = new Set<number>();
    (renderer as any).inputs = new Proxy(target, { set: (array, key, value, receiver) => {
      if (typeof key === "string" && /^\d+$/.test(key)) written.add(Math.floor(Number(key) / 5));
      return Reflect.set(array, key, value, receiver);
    } });
    return { written: () => [...written].sort((a, b) => a - b) };
  }
  it("records only the inputs from the first changed bar", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi, OTHER.stochastic], f.candles);
    const recorded = watchRecordedInputs(f.renderer);
    f.candles[700] = { ...f.candles[700]!, close: 140 };
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    expect(f.chart.removeSeries).toHaveBeenCalledTimes(2); // the patch path
    // Bars before the correction were recorded already and are not rewritten;
    // the corrected bar and everything after it are.
    const written = recorded.written();
    expect(written[0]).toBe(700);
    expect(written).toHaveLength(COUNT - 700);
  });
  it("a refresh records the inputs only from its dirty bar, not the whole history", () => {
    const f = fixture(COUNT);
    f.renderer.setStudies([OTHER.sma, OTHER.rsi], f.candles);
    const recorded = watchRecordedInputs(f.renderer);
    // Count the renderer's own reads of the bars before the dirty one; the
    // calculators get the plain array.
    let readsBefore = 0, from = COUNT - 1;
    const candles = new Proxy(f.candles, { get: (target, key, receiver) => {
      if (typeof key === "string" && /^\d+$/.test(key) && Number(key) < from) readsBefore++;
      return Reflect.get(target, key, receiver);
    } });
    const calculate = StudyCalculator.prototype.calculate;
    const spy = vi.spyOn(StudyCalculator.prototype, "calculate").mockImplementation(function (this: StudyCalculator, _bars, start = 0, collect = true) {
      return calculate.call(this, f.candles, start, collect);
    });
    try {
      // A stream tick revising the last bar, then a correction from bar 1000.
      f.candles[from] = { ...f.candles[from]!, close: 97 };
      f.renderer.refresh(candles, from, false);
      expect(recorded.written()).toEqual([from]);
      from = 1000;
      f.candles[from] = { ...f.candles[from]!, close: 141 };
      f.renderer.refresh(candles, from, false);
      expect(recorded.written()[0]).toBe(1000);
    } finally { spy.mockRestore(); }
    // Bounded by the dirty suffix, not by the 1000+ bars of history before it.
    expect(readsBefore).toBeLessThan(10);
  });
});
