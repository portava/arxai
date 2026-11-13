import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const lineState: Record<string, any> = {};
  const seriesState: Record<string, any> = {};
  const line = { options: () => ({...lineState}), applyOptions: vi.fn((change) => Object.assign(lineState, change)) };
  const series = { attachPrimitive: vi.fn(), setData: vi.fn(), update: vi.fn(), pop: vi.fn(), options: () => ({...seriesState}), applyOptions: vi.fn(change => Object.assign(seriesState, change)), createPriceLine: vi.fn(options => {Object.assign(lineState,options);return line;}), removePriceLine: vi.fn(), priceToCoordinate: vi.fn() };
  const scale = { subscribeVisibleLogicalRangeChange: vi.fn(), getVisibleRange: vi.fn(() => ({from:100,to:400})), getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 1 })), setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(), scrollToRealTime: vi.fn(), scrollToPosition: vi.fn(), options:()=>({rightOffset:8}) };
  const chart = { addSeries: vi.fn((_kind,options) => {for(const key of Object.keys(seriesState))delete seriesState[key];Object.assign(seriesState,{priceLineVisible:true,lastValueVisible:true},options);return series;}), subscribeCrosshairMove: vi.fn(), setCrosshairPosition:vi.fn(), clearCrosshairPosition:vi.fn(), timeScale: () => scale, applyOptions: vi.fn(), remove: vi.fn() };
  const createChart = vi.fn((_el: unknown, _options: any) => chart);
  return { line, series, scale, chart, createChart };
});
vi.mock("@/lib/chart-engine/arxCanvas", () => ({ createChart: (el: unknown, options: unknown) => mocks.createChart(el, options), CandlestickSeries: {}, LineSeries: {}, createSeriesMarkers: vi.fn(), ColorType: { Solid: "solid" }, CrosshairMode: {Normal: 0}, LineStyle: {Dashed: 2}, PriceScaleMode: {Normal: 0, Logarithmic: 1, Percentage:2, IndexedTo100:3} }));
import { ArxCanvasAdapter } from "./arxCanvasAdapter";
import { sanitizeCandlestickData } from "./candleSanitize";
import { candleDisplayPrecision } from "./candleReconciliation";
import { CHART_INTERVALS, chartIntervalSeconds } from "./chartIntervals";
const bar = (time: number, close = 1.15) => ({time,open:1.1,high:1.2,low:1.0,close});
let adapter: ArxCanvasAdapter;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe(){} disconnect(){} });
  mocks.scale.getVisibleLogicalRange.mockReturnValue({from:0,to:1});
  adapter = new ArxCanvasAdapter();
  adapter.init({container:document.createElement("div"),height:400});
});
afterEach(() => {adapter.destroy();vi.useRealTimers();});
describe("chart refresh and inspection", () => {
  it("avoids all series work for identical polls; tail edits and appends use update", () => {
    adapter.setCandles([bar(100),bar(200),bar(300)]);
    adapter.setCandles([bar(100),bar(200),bar(300)]);
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
    expect(mocks.series.update).not.toHaveBeenCalled();
    adapter.setCandles([bar(100),bar(200),bar(300,1.16),bar(400)]);
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
    expect(mocks.series.update.mock.calls.map(([c])=>c.time)).toEqual([300,400]);
  });
  it("bulk appends use one replacement while small unchanged truncations pop", () => {
    const candles = Array.from({length:5000},(_,i)=>bar(100+i*60));
    adapter.setCandles(candles.slice(0,1));
    adapter.setCandles(candles);
    expect(mocks.series.setData).toHaveBeenCalledTimes(2);
    expect(mocks.series.update).not.toHaveBeenCalled();
    adapter.setCandles(candles.slice(0,-1));
    expect(mocks.series.pop).toHaveBeenLastCalledWith(1);
    expect(mocks.series.setData).toHaveBeenCalledTimes(2);
    adapter.setCandles(candles);
    expect(mocks.series.update).toHaveBeenLastCalledWith(candles.at(-1));
    adapter.setCandles([]);
    expect(mocks.series.setData).toHaveBeenLastCalledWith([]);
    adapter.setCandles(candles.slice(0,1));
    adapter.setCandles([]);
    expect(mocks.series.pop).toHaveBeenLastCalledWith(1);
  });
  it("bulk appends preserve past inspection and follow the edge only when already there", () => {
    const candles = Array.from({length:100},(_,i)=>bar(100+i*60));
    adapter.setCandles(candles.slice(0,10));
    mocks.scale.getVisibleLogicalRange.mockReturnValue({from:0,to:3});
    adapter.setCandles(candles.slice(0,50));
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:0,to:3});
    mocks.scale.getVisibleLogicalRange.mockReturnValue({from:40,to:55});
    adapter.setCandles(candles);
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:90,to:105});
  });
  it("a shortened but revised prefix cannot use tail removal", () => {
    adapter.setCandles([bar(100),bar(200),bar(300)]);
    adapter.setCandles([bar(100,1.19),bar(200)]);
    expect(mocks.series.pop).not.toHaveBeenCalled();
    expect(mocks.series.setData).toHaveBeenLastCalledWith([bar(100,1.19),bar(200)]);
  });
  it("replaces historical corrections rather than losing them in a tail optimization", () => {
    adapter.setCandles([bar(100),bar(200),bar(300)]);
    adapter.setCandles([bar(100,1.19),bar(200),bar(300)]);
    expect(mocks.series.setData).toHaveBeenCalledTimes(2);
  });
  it("holds the same timestamp window when older bars are prepended", () => {
    adapter.setCandles([bar(200),bar(300),bar(400)]);
    adapter.setCandles([bar(100),bar(200),bar(300),bar(400)]);
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:1,to:2});
  });
  it("holds the same timestamp window when the oldest bar rolls off", () => {
    adapter.setCandles([bar(100),bar(200),bar(300)]);
    adapter.setCandles([bar(200),bar(300),bar(400)]);
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:-1,to:0});
  });
  it("follows latest on rolling polls only when already at the right edge", () => {
    mocks.scale.getVisibleLogicalRange.mockReturnValue({from:1,to:10});
    adapter.setCandles([bar(100),bar(200),bar(300)]);
    adapter.setCandles([bar(200),bar(300),bar(400)]);
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:1,to:10});
  });
  it("retains a newer streamed bar until the authoritative window catches up", () => {
    adapter.setCandles([bar(100),bar(200)]);
    adapter.updateActiveCandle(bar(300));
    adapter.setCandles([bar(100),bar(200)]);
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
    adapter.setCandles([bar(100),bar(200),bar(300,1.17)]);
    expect(mocks.series.update).toHaveBeenLastCalledWith(bar(300,1.17));
  });
  it.each([
    ["mt5_broker", "deriv_public"], ["deriv_public", "mt5_broker"],
    ["deriv", "deriv_public"], ["deriv_public", "deriv"],
    ["mt5_broker", null], ["deriv_public", undefined],
  ])("drops a retained tip when history source changes from %s to %s", (from, to) => {
    adapter.setFeedState({livePriceAffordance:true,source:from});
    adapter.setCandles([bar(100),bar(200)]);
    adapter.updateActiveCandle(bar(300,1.19));
    // An ordinary poll on the original source still preserves the newer tip.
    adapter.setFeedState({livePriceAffordance:true,source:from});
    adapter.setCandles([bar(100),bar(200)]);
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
    adapter.setFeedState({livePriceAffordance:true,source:to});
    adapter.setCandles([bar(100),bar(200)]);
    expect(mocks.series.pop).toHaveBeenCalledExactlyOnceWith(1);
    expect((adapter as any).candles).toEqual([bar(100),bar(200)]);
    expect((adapter as any).streamTip).toBeNull();
    // The replacement source can recover at an earlier valid forming interval.
    adapter.updateActiveCandle(bar(200,1.16));
    expect(mocks.series.update).toHaveBeenLastCalledWith(bar(200,1.16));
  });
  it("updates the Last line on a streamed price and removes it when stale", () => {
    adapter.setFeedState({livePriceAffordance:true});
    adapter.setCandles([bar(100)]);
    adapter.updateActiveCandle(bar(100,1.17));
    expect(mocks.line.applyOptions).toHaveBeenLastCalledWith({price:1.17});
    adapter.setFeedState({livePriceAffordance:false});
    expect(mocks.series.removePriceLine).toHaveBeenCalledWith(mocks.line);
    expect(mocks.series.applyOptions).toHaveBeenLastCalledWith({priceLineVisible:false,lastValueVisible:false});
  });
  it("rejects malformed and older streaming bars", () => {
    adapter.setCandles([bar(200)]);
    adapter.updateActiveCandle(bar(100));
    adapter.updateActiveCandle({...bar(300),high:0});
    expect(mocks.series.update).not.toHaveBeenCalled();
  });
  it("sorts and deduplicates snapshots while rejecting invalid OHLC", () => {
    expect(sanitizeCandlestickData([bar(300),bar(100),bar(100,1.16),{...bar(200),low:3}])).toEqual([bar(100,1.16),bar(300)]);
  });
  it("keeps FX and small-asset prices readable", () => {
    adapter.setSymbol("EURUSD");
    adapter.setCandles([bar(100)]);
    expect(mocks.series.applyOptions).toHaveBeenCalledWith({priceFormat:{type:"price",precision:5,minMove:10**-5}});
    expect(candleDisplayPrecision([{time:100,open:.00001234,high:.00001238,low:.0000123,close:.00001235}])).toBe(8);
  });
  it("supports all four price scales and date navigation without changing canonical prices", () => {
    adapter.setCandles([bar(100),bar(200),bar(300),bar(400)]);
    adapter.setScaleMode("percent");
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({rightPriceScale:{mode:2}});
    adapter.setScaleMode("indexed");
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({rightPriceScale:{mode:3}});
    adapter.setPriceScaleInverted(true);
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({rightPriceScale:{invertScale:true}});
    expect(adapter.goToTime(250)).toBe(true);
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:-8,to:12});
    expect(adapter.goToTime(50)).toBe(false);
    expect(adapter.goToTime(NaN)).toBe(false);
    expect(adapter.showRecentRange(150)).toEqual({complete:true});
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:2,to:6});
    expect(adapter.showRecentRange(1000)).toEqual({complete:false});
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
  });
  it("resizes without recreating the chart and offers explicit viewport commands", () => {
    adapter.resize(1000,700);
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({width:1000,height:700});
    expect(mocks.chart.remove).not.toHaveBeenCalled();
    adapter.goToLatest(); adapter.fitHistory(); adapter.setScaleMode("log");
    expect(mocks.scale.scrollToRealTime).toHaveBeenCalledOnce();
    adapter.goToLatest(false);
    expect(mocks.scale.scrollToPosition).toHaveBeenCalledExactlyOnceWith(8,false);
    expect(mocks.scale.scrollToRealTime).toHaveBeenCalledOnce();
    expect(mocks.scale.fitContent).toHaveBeenCalledOnce();
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({rightPriceScale:{mode:1}});
  });
});

describe("linked view adapter boundaries", () => {
  it.each(CHART_INTERVALS)("uses %s's observed span for crosshair and range linking without bridging missing bars", timeframe => {
    const seconds=chartIntervalSeconds(timeframe)!, start=Date.parse("2026-10-19T00:00:00Z")/1000;
    adapter.setTimeframe(timeframe);adapter.setCandles([bar(start),bar(start+seconds*2,1.17)]);
    adapter.setLinkedCrosshair(start+seconds-1);
    expect(mocks.chart.setCrosshairPosition).toHaveBeenLastCalledWith(1.15,start,mocks.series);
    adapter.setLinkedCrosshair(start+seconds);
    expect(mocks.chart.clearCrosshairPosition).toHaveBeenCalled();
    const status=vi.fn();adapter.setViewLinkStatusHandler(status);
    mocks.scale.setVisibleLogicalRange.mockClear();
    adapter.setLinkedTimeRange({from:start+seconds,to:start+seconds*2-1});
    expect(mocks.scale.setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("has not moved"));
    adapter.setLinkedTimeRange({from:start+seconds*2+1,to:start+seconds*3-1});
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:1,to:1});
    expect(status).toHaveBeenLastCalledWith("");
  });
  it("uses the target candle's own close and clears missing times rather than substituting latest", () => {
    vi.useFakeTimers(); adapter.setTimeframe("M1");adapter.setCandles([bar(100),bar(160,1.17),bar(500)]);
    const legend=vi.fn(), publish=vi.fn();adapter.setCrosshairHandler(legend);adapter.setViewLinkHandler(publish);
    adapter.setLinkedCrosshair(190);vi.advanceTimersByTime(20);
    expect(mocks.chart.setCrosshairPosition).toHaveBeenLastCalledWith(1.17,160,mocks.series);expect(legend).toHaveBeenLastCalledWith(bar(160,1.17));
    adapter.setLinkedCrosshair(220);vi.advanceTimersByTime(20);
    expect(mocks.chart.clearCrosshairPosition).toHaveBeenCalled();expect(legend).toHaveBeenLastCalledWith(null);expect(publish).not.toHaveBeenCalled();
  });
  it("clips by actual target timestamps and reports unavailable windows without moving", () => {
    adapter.setTimeframe("M1");adapter.setCandles([bar(100),bar(160),bar(500),bar(560)]);
    const status=vi.fn();adapter.setViewLinkStatusHandler(status);
    adapter.setLinkedTimeRange({from:120,to:550});expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:0,to:2});expect(status).toHaveBeenLastCalledWith("");
    adapter.setLinkedTimeRange({from:10,to:150});expect(status).toHaveBeenLastCalledWith(expect.stringContaining("clipped"));
    mocks.scale.setVisibleLogicalRange.mockClear();adapter.setLinkedTimeRange({from:300,to:400});expect(mocks.scale.setVisibleLogicalRange).not.toHaveBeenCalled();expect(status).toHaveBeenLastCalledWith(expect.stringContaining("has not moved"));
    adapter.setLinkedTimeRange(null);expect(status).toHaveBeenLastCalledWith("");
  });
  it("publishes user navigation but suppresses deferred range echoes until a new local gesture", () => {
    vi.useFakeTimers();adapter.setTimeframe("M1");adapter.setCandles([bar(100),bar(160),bar(220),bar(400)]);
    const publish=vi.fn();adapter.setViewLinkHandler(publish);
    const onRange=mocks.scale.subscribeVisibleLogicalRangeChange.mock.calls[0]![0];
    adapter.resetScale();onRange({from:0,to:3});vi.advanceTimersByTime(20);expect(publish).toHaveBeenCalledExactlyOnceWith({kind:"range",range:{from:100,to:400}});
    publish.mockClear();adapter.setLinkedTimeRange({from:150,to:300});vi.advanceTimersByTime(20);onRange({from:.5,to:2.5});vi.advanceTimersByTime(20);expect(publish).not.toHaveBeenCalled();
    adapter.fitHistory();onRange({from:0,to:3});vi.advanceTimersByTime(20);expect(publish).toHaveBeenCalledTimes(1);
  });
  it("does not start history paging in linked followers; local navigation can still load history", () => {
    adapter.setCandles([bar(100),bar(160),bar(220)]);const load=vi.fn();adapter.setReachStartHandler(load);
    const onRange=mocks.scale.subscribeVisibleLogicalRangeChange.mock.calls[0]![0];
    adapter.setLinkedTimeRange({from:50,to:200});onRange({from:0,to:2});expect(load).not.toHaveBeenCalled();
    adapter.resetScale();onRange({from:0,to:2});expect(load).toHaveBeenCalledTimes(1);
  });
  it("coalesces real cursor moves and never publishes programmatic crosshair recalculation", () => {
    vi.useFakeTimers();adapter.setCandles([bar(100),bar(200)]);const publish=vi.fn();adapter.setViewLinkHandler(publish);
    const move=mocks.chart.subscribeCrosshairMove.mock.calls[0]![0];
    move({time:100,point:{x:1,y:1},sourceEvent:{}});move({time:200,point:{x:2,y:1},sourceEvent:{}});vi.advanceTimersByTime(20);
    expect(publish).toHaveBeenCalledExactlyOnceWith({kind:"crosshair",time:200});publish.mockClear();
    move({time:100,point:{x:1,y:1}});vi.advanceTimersByTime(20);expect(publish).not.toHaveBeenCalled();
    move({time:200,point:{x:1,y:1},sourceEvent:{}});adapter.destroy();vi.advanceTimersByTime(20);expect(publish).not.toHaveBeenCalled();
  });
});

describe("display time zone", () => {
  const TOKYO_1446 = Date.UTC(2026, 9, 28, 5, 46) / 1000;
  const installed = () => mocks.createChart.mock.calls.at(-1)![1];
  it("installs stable formatters at createChart that reproduce the library defaults under UTC", () => {
    const options = installed();
    expect(navigator.language).toBe("en-US");
    expect(options.localization.timeFormatter(TOKYO_1446)).toBe("28 Oct '26   05:46");
    expect(options.timeScale.tickMarkFormatter(TOKYO_1446, 3, "en-US")).toBeNull();
    expect(options.timeScale.timeVisible).toBe(true);
    expect(options.timeScale.secondsVisible).toBe(false);
    mocks.chart.applyOptions.mockClear();
    adapter.setDisplayTimeZone("Asia/Tokyo");
    expect(mocks.chart.applyOptions).toHaveBeenCalledTimes(1);
    const applied = mocks.chart.applyOptions.mock.calls[0]![0] as any;
    expect(applied.localization.timeFormatter).toBe(options.localization.timeFormatter);
    expect(applied.timeScale.tickMarkFormatter).toBe(options.timeScale.tickMarkFormatter);
    expect(options.localization.timeFormatter(TOKYO_1446)).toBe("28 Oct '26   14:46 GMT+9");
    expect(options.timeScale.tickMarkFormatter(TOKYO_1446, 3, "en-US")).toBe("14:46");
    adapter.setDisplayTimeZone("Asia/Tokyo");
    expect(mocks.chart.applyOptions).toHaveBeenCalledTimes(1);
    adapter.setDisplayTimeZone("UTC");
    expect(mocks.chart.applyOptions).toHaveBeenCalledTimes(2);
    expect(options.localization.timeFormatter(TOKYO_1446)).toBe("28 Oct '26   05:46");
  });
  it("keeps the zone across a re-init without touching data", () => {
    adapter.setDisplayTimeZone("Asia/Tokyo");
    adapter.init({container:document.createElement("div"),height:400});
    expect(installed().localization.timeFormatter(TOKYO_1446)).toBe("28 Oct '26   14:46 GMT+9");
  });
  it("leaves goToTime, candle data and UTC-second navigation unchanged", () => {
    adapter.setCandles([bar(100),bar(200),bar(300),bar(400)]);
    adapter.setDisplayTimeZone("Asia/Tokyo");
    expect(adapter.goToTime(250)).toBe(true);
    expect(mocks.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:-8,to:12});
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
    expect(mocks.series.update).not.toHaveBeenCalled();
  });
  it("resolves one linked UTC second to the same candle under UTC and Tokyo, and publishes raw UTC seconds", () => {
    vi.useFakeTimers(); adapter.setTimeframe("M1");adapter.setCandles([bar(100),bar(160,1.17),bar(500)]);
    const legend=vi.fn(), publish=vi.fn();adapter.setCrosshairHandler(legend);adapter.setViewLinkHandler(publish);
    adapter.setLinkedCrosshair(190);vi.advanceTimersByTime(20);
    const utcCall=mocks.chart.setCrosshairPosition.mock.lastCall, utcBar=legend.mock.lastCall;
    expect(utcCall).toEqual([1.17,160,mocks.series]);
    adapter.setLinkedCrosshair(null);vi.advanceTimersByTime(20);
    adapter.setDisplayTimeZone("Asia/Tokyo");
    adapter.setLinkedCrosshair(190);vi.advanceTimersByTime(20);
    expect(mocks.chart.setCrosshairPosition.mock.lastCall).toEqual(utcCall);
    expect(legend.mock.lastCall).toEqual(utcBar);
    expect(publish).not.toHaveBeenCalled();
    const move=mocks.chart.subscribeCrosshairMove.mock.calls[0]![0];
    move({time:160,point:{x:1,y:1},sourceEvent:{}});vi.advanceTimersByTime(20);
    expect(publish).toHaveBeenCalledExactlyOnceWith({kind:"crosshair",time:160});
    expect(mocks.series.setData).toHaveBeenCalledTimes(1);
  });
});

describe("streamed candles notify the reader without a range change", () => {
  it("coalesces a burst of applied revisions into one notification with the final OHLC", () => {
    vi.useFakeTimers();
    adapter.setCandles([bar(100), bar(200)]);
    const observed: number[] = [];
    adapter.subscribeViewport(() => observed.push(adapter.getVisibleCandles().at(-1)!.close));
    for (let i = 0; i < 100; i++) adapter.updateActiveCandle(bar(200, 1.10 + i / 1000));
    expect(observed).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(observed).toEqual([1.199]);
    expect(adapter.getVisibleCandles()).toEqual([bar(100), bar(200, 1.199)]);
  });
  it("ignores rejected streamed data and does not notify removed readers", () => {
    vi.useFakeTimers();
    adapter.setCandles([bar(200)]);
    const notify = vi.fn();
    const remove = adapter.subscribeViewport(notify);
    adapter.updateActiveCandle(bar(100));
    adapter.updateActiveCandle({ ...bar(200), high: 0 });
    vi.advanceTimersByTime(20);
    expect(notify).not.toHaveBeenCalled();
    adapter.updateActiveCandle(bar(200, 1.19));
    remove();
    vi.advanceTimersByTime(20);
    expect(notify).not.toHaveBeenCalled();
    adapter.subscribeViewport(notify);
    adapter.updateActiveCandle(bar(200, 1.18));
    adapter.destroy();
    vi.advanceTimersByTime(20);
    expect(notify).not.toHaveBeenCalled();
  });
});

it("withdraws a visible reader explanation after a streamed OHLC revision and recovers on matching history", async () => {
  const { createElement } = await import("react");
  const { render, act, cleanup } = await import("@testing-library/react/pure");
  const { SmartChartReader } = await import("../../components/charts/SmartChartReader");
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  const caf = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const flushFrame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(performance.now()); };
  const start = Date.parse("2026-10-31T10:00:00Z");
  vi.setSystemTime(start + 30 * 300_000);
  const raw = Array.from({ length: 30 }, (_, i) => ({
    symbol: "V75", timeframe: "M5", source: "deriv_public", sourceMode: "live",
    openTime: new Date(start + i * 300_000).toISOString(), closeTime: new Date(start + (i + 1) * 300_000).toISOString(),
    open: 100, high: 101, low: 99, close: 100, isComplete: true, isFinal: true, isForming: false, qualityFlags: [],
  }));
  const canonical = raw.map(c => ({ time: Date.parse(c.openTime) / 1000, open: c.open, high: c.high, low: c.low, close: c.close }));
  const data = { symbol: "V75", timeframe: "M5", source: "deriv_public", quality: "clean", candles: raw,
    feedStatus: { source: "deriv_public" }, marketEvidence: { symbol: "V75", timeframe: "M5", source: "deriv_public", sourceIdentity: "a".repeat(64), lastClosedCandleAt: raw.at(-1)!.closeTime } };
  mocks.scale.getVisibleLogicalRange.mockReturnValue({ from: 0, to: 29 });
  adapter.setCandles(canonical);
  const annotation = vi.spyOn(adapter, "setSmartAnnotation");
  const view = render(createElement(SmartChartReader, { adapter, epoch: 1, symbol: "V75", timeframe: "M5", data: data as any, liveConfirmed: true, readFailed: false }));
  try {
    act(flushFrame);
    expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("ready");
    const notified = vi.fn(); adapter.subscribeViewport(notified);
    act(() => { adapter.updateActiveCandle({ ...canonical.at(-1)!, close: 100.5 }); flushFrame(); });
    expect(adapter.getVisibleCandles().at(-1)?.close).toBe(100.5);
    expect(notified).toHaveBeenCalledOnce();
    expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("unavailable");
    expect(view.getByTestId("chart-reader-explanation").textContent).toContain("displayed candles are updating");
    expect(annotation).toHaveBeenLastCalledWith(null);
    act(() => { adapter.setCandles(canonical); flushFrame(); });
    expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("ready");
    const confirmedAsOf = view.getByTestId("smart-chart-reader").getAttribute("data-analysis-asof");
    const tip = { ...canonical.at(-1)!, time: canonical.at(-1)!.time + 300 };
    mocks.scale.getVisibleLogicalRange.mockReturnValue({ from: 0, to: 30 });
    act(() => { for (let i = 0; i < 100; i++) adapter.updateActiveCandle({ ...tip, close: 100 + i / 1000 }); flushFrame(); });
    expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("ready");
    expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-asof")).toBe(confirmedAsOf);
    expect(view.getByTestId("chart-reader-context").textContent).toContain("30 closed candles");
    // Two streamed bars do not certify that the older tip has closed at its source.
    mocks.scale.getVisibleLogicalRange.mockReturnValue({ from: 0, to: 31 });
    act(() => { adapter.updateActiveCandle({ ...tip, time: tip.time + 300 }); flushFrame(); });
    expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("unavailable");
    expect(annotation).toHaveBeenLastCalledWith(null);
  } finally { cleanup(); adapter.destroy(); raf.mockRestore(); caf.mockRestore(); }
});

describe("live-price settings on repeated reconciliation",()=>{
 it.each([false,true])("repeated identical polls do not rewrite price settings (live=%s)",live=>{
  const candles=[bar(100),bar(200)];adapter.setFeedState({livePriceAffordance:live,source:"fixture"});adapter.setCandles(candles);
  mocks.series.applyOptions.mockClear();mocks.line.applyOptions.mockClear();mocks.series.setData.mockClear();mocks.series.update.mockClear();
  for(let i=0;i<20;i++){adapter.setFeedState({livePriceAffordance:live,source:"fixture"});adapter.setCandles(candles);}
  expect(mocks.series.applyOptions).not.toHaveBeenCalled();expect(mocks.line.applyOptions).not.toHaveBeenCalled();expect(mocks.series.setData).not.toHaveBeenCalled();expect(mocks.series.update).not.toHaveBeenCalled();
 });
 it("withdraws live labels immediately, including repeated stale and resumed states",()=>{
  adapter.setFeedState({livePriceAffordance:true,source:"fixture"});adapter.setCandles([bar(100)]);
  mocks.series.applyOptions.mockClear();mocks.series.removePriceLine.mockClear();
  adapter.setFeedState({livePriceAffordance:false,source:"fixture"});adapter.setFeedState({livePriceAffordance:false,source:"fixture"});
  expect(mocks.series.options()).toMatchObject({priceLineVisible:false,lastValueVisible:false});expect(mocks.series.applyOptions).toHaveBeenCalledTimes(1);expect(mocks.series.removePriceLine).toHaveBeenCalledTimes(1);
  adapter.setFeedState({livePriceAffordance:true,source:"fixture"});expect(mocks.series.options()).toMatchObject({priceLineVisible:true,lastValueVisible:true});expect(mocks.line.options().price).toBe(1.15);
 });
 it("still updates canonical Last when only the candle price changes",()=>{
  adapter.setFeedState({livePriceAffordance:true,source:"fixture"});adapter.setCandles([bar(100)]);mocks.line.applyOptions.mockClear();mocks.series.applyOptions.mockClear();
  adapter.setCandles([bar(100,1.17)]);expect(mocks.line.options().price).toBe(1.17);expect(mocks.line.applyOptions).toHaveBeenCalledExactlyOnceWith({price:1.17});expect(mocks.series.applyOptions).not.toHaveBeenCalled();
  mocks.line.applyOptions.mockClear();adapter.updateActiveCandle(bar(100,1.17));expect(mocks.line.applyOptions).not.toHaveBeenCalled();
  adapter.updateActiveCandle(bar(100,1.18));expect(mocks.line.options().price).toBe(1.18);
 });
 it("repairs either actual label setting and Last price if changed elsewhere",()=>{
  adapter.setFeedState({livePriceAffordance:true,source:"fixture"});adapter.setCandles([bar(100)]);
  for(const key of ['priceLineVisible','lastValueVisible']){
   mocks.series.applyOptions({[key]:false});mocks.series.applyOptions.mockClear();adapter.setFeedState({livePriceAffordance:true,source:"fixture"});expect(mocks.series.applyOptions).toHaveBeenCalledExactlyOnceWith({priceLineVisible:true,lastValueVisible:true});
  }
  mocks.line.applyOptions({price:999});adapter.setFeedState({livePriceAffordance:true,source:"fixture"});expect(mocks.line.options().price).toBe(1.15);
 });
 it("clears and repopulates without retaining a stale Last line",()=>{
  adapter.setFeedState({livePriceAffordance:true,source:"fixture"});adapter.setCandles([bar(100)]);adapter.setCandles([]);expect(mocks.series.removePriceLine).toHaveBeenCalledWith(mocks.line);
  adapter.setFeedState({livePriceAffordance:false,source:null});adapter.setCandles([bar(200,1.19)]);expect(mocks.series.options()).toMatchObject({priceLineVisible:false,lastValueVisible:false});
  adapter.setFeedState({livePriceAffordance:true,source:"next"});expect(mocks.line.options().price).toBe(1.19);
 });
});
