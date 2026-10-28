// One instrument → one display precision (owner screenshots 2026-10-27, V75 1m:
// header 33,588.01, chart badge 33588.0069 then 33575.372, axis 33575.37).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  candlestickPriceFormat,
  formatInstrumentPrice,
  observedPriceDecimals,
  resolveDisplayClose,
  resolveDisplayPricePrecision,
  seedInstrumentPrice,
} from "./instrumentPriceFormat";
import { fetchChartCandles } from "./chartCandlesQuery";
import { publishScannerTip, readScannerTip, scannerTipKey } from "./scannerLiveTipStore";

afterEach(() => vi.unstubAllGlobals());

describe("resolveDisplayPricePrecision", () => {
  it("V75: server 4 dp + 4-dp Deriv quotes → 4 everywhere (the trailing-zero bar 33575.372 does not drop to 3)", () => {
    expect(resolveDisplayPricePrecision(4, [33588.0069, 33575.372])).toBe(4);
    expect(observedPriceDecimals([33575.372])).toBe(3);
  });

  it("never rounds away quoted digits when the profile under-states them (old V75 profile said 3)", () => {
    expect(resolveDisplayPricePrecision(3, [33588.0069])).toBe(4);
  });

  it("never invents more than server + 2 digits from float noise", () => {
    expect(resolveDisplayPricePrecision(2, [1.123456789])).toBe(4);
  });

  it("uses observed digits with no server precision, null with neither", () => {
    expect(resolveDisplayPricePrecision(null, [1.08123])).toBe(5);
    expect(resolveDisplayPricePrecision(null, [])).toBeNull();
    expect(resolveDisplayPricePrecision(undefined, [Number.NaN])).toBeNull();
  });
});

describe("formatInstrumentPrice", () => {
  it("prints one fixed precision with no thousands grouping (matches the price axis)", () => {
    expect(formatInstrumentPrice(33588.0069, 4)).toBe("33588.0069");
    expect(formatInstrumentPrice(33575.372, 4)).toBe("33575.3720");
    expect(formatInstrumentPrice(33250.6, 4)).toBe("33250.6000");
  });

  it("falls back to a magnitude heuristic only when precision is unknown", () => {
    expect(formatInstrumentPrice(1.08123, null)).toBe("1.08123");
    expect(formatInstrumentPrice(150.1234, null)).toBe("150.123");
    expect(formatInstrumentPrice(33588.0069, null)).toBe("33588.01");
    expect(formatInstrumentPrice(null, 4)).toBe("—");
    expect(formatInstrumentPrice(Number.NaN, 4)).toBe("—");
  });

  it("seeds editable inputs at the same precision", () => {
    expect(seedInstrumentPrice(33588.0069, 4)).toBe("33588.0069");
    expect(seedInstrumentPrice(33575.372, 4)).toBe("33575.372");
    expect(seedInstrumentPrice(Number.NaN, 4)).toBe("");
  });

  it("gives lightweight-charts a matching priceFormat (precision 4 / minMove 0.0001)", () => {
    expect(candlestickPriceFormat(4)).toEqual({ type: "price", precision: 4, minMove: 0.0001 });
    expect(candlestickPriceFormat(null)).toBeNull();
  });
});

describe("resolveDisplayClose — badge, header and axis show ONE observation", () => {
  it("a live tick tip (what the axis shows) wins over the 15s poll close", () => {
    expect(resolveDisplayClose({ tipClose: 33575.372, lastClose: 33588.0069, isLive: true }))
      .toEqual({ value: 33575.372, basis: "tick" });
  });

  it("no tip → the poll close", () => {
    expect(resolveDisplayClose({ tipClose: null, lastClose: 33588.0069, isLive: true }))
      .toEqual({ value: 33588.0069, basis: "poll" });
  });

  it("off a live display a tick never shows — only the poll close", () => {
    expect(resolveDisplayClose({ tipClose: 33575.372, lastClose: 33588.0069, isLive: false }))
      .toEqual({ value: 33588.0069, basis: "poll" });
    expect(resolveDisplayClose({ tipClose: null, lastClose: null, isLive: false }))
      .toEqual({ value: null, basis: null });
  });
});

describe("scanner live-tip store", () => {
  it("publishes per symbol+timeframe and clears", () => {
    const key = scannerTipKey("v75", "1m");
    expect(key).toBe("V75|1m");
    publishScannerTip(key, 33575.372);
    expect(readScannerTip(key)).toBe(33575.372);
    expect(readScannerTip(scannerTipKey("V75", "5m"))).toBeNull();
    publishScannerTip(key, null);
    expect(readScannerTip(key)).toBeNull();
  });
});

describe("fetchChartCandles carries the server's declared precision", () => {
  function stub(body: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
  }

  it("reads truthResult.pricePrecision", async () => {
    stub({ candles: [], feedStatus: null, truthResult: { pricePrecision: 4, pipSize: 0.0001 } });
    expect((await fetchChartCandles("V75", "M1", 200)).pricePrecision).toBe(4);
  });

  it("is null (never guessed) when absent or malformed", async () => {
    stub({ candles: [], feedStatus: null, truthResult: null });
    expect((await fetchChartCandles("V75", "M1", 200)).pricePrecision).toBeNull();
    stub({ candles: [], feedStatus: null, truthResult: { pricePrecision: "4" } });
    expect((await fetchChartCandles("V75", "M1", 200)).pricePrecision).toBeNull();
  });
});
