import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const line = { applyOptions: vi.fn() };
  const series = { setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(), createPriceLine: vi.fn(() => line), removePriceLine: vi.fn(), priceToCoordinate: vi.fn() };
  const scale = { subscribeVisibleLogicalRangeChange: vi.fn(), getVisibleRange: vi.fn(() => ({from:100,to:400})), getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 1 })), setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(), scrollToRealTime: vi.fn() };
  const chart = { addSeries: vi.fn(() => series), subscribeCrosshairMove: vi.fn(), setCrosshairPosition:vi.fn(), clearCrosshairPosition:vi.fn(), timeScale: () => scale, applyOptions: vi.fn(), remove: vi.fn() };
  return { line, series, scale, chart };
});
vi.mock("lightweight-charts", () => ({ createChart: () => mocks.chart, CandlestickSeries: {}, LineSeries: {}, createSeriesMarkers: vi.fn(), ColorType: { Solid: "solid" }, CrosshairMode: {Normal: 0}, LineStyle: {Dashed: 2}, PriceScaleMode: {Normal: 0, Logarithmic: 1, Percentage:2, IndexedTo100:3} }));
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import { sanitizeCandlestickData } from "./candleSanitize";
import { candleDisplayPrecision } from "./candleReconciliation";
const bar = (time: number, close = 1.15) => ({time,open:1.1,high:1.2,low:1.0,close});
let adapter: LightweightChartsAdapter;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe(){} disconnect(){} });
  mocks.scale.getVisibleLogicalRange.mockReturnValue({from:0,to:1});
  adapter = new LightweightChartsAdapter();
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
    expect(mocks.series.setData).toHaveBeenLastCalledWith([bar(100),bar(200)]);
    expect(mocks.series.setData).toHaveBeenCalledTimes(2);
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
    expect(mocks.scale.fitContent).toHaveBeenCalledOnce();
    expect(mocks.chart.applyOptions).toHaveBeenLastCalledWith({rightPriceScale:{mode:1}});
  });
});

describe("linked view adapter boundaries", () => {
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
