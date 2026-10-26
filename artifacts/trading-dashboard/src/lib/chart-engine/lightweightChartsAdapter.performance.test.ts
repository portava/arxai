import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const line = { applyOptions: vi.fn() };
  const series = { setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(), createPriceLine: vi.fn(() => line), removePriceLine: vi.fn(), priceToCoordinate: vi.fn() };
  const scale = { subscribeVisibleLogicalRangeChange: vi.fn(), getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 1 })), setVisibleLogicalRange: vi.fn(), setVisibleRange: vi.fn(), fitContent: vi.fn(), scrollToRealTime: vi.fn() };
  const chart = { addSeries: vi.fn(() => series), subscribeCrosshairMove: vi.fn(), timeScale: () => scale, applyOptions: vi.fn(), remove: vi.fn() };
  return { line, series, scale, chart };
});
vi.mock("lightweight-charts", () => ({ createChart: () => mocks.chart, CandlestickSeries: {}, LineSeries: {}, createSeriesMarkers: vi.fn(), ColorType: { Solid: "solid" }, CrosshairMode: {Normal: 0}, LineStyle: {Dashed: 2}, PriceScaleMode: {Normal: 0, Logarithmic: 1} }));
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
