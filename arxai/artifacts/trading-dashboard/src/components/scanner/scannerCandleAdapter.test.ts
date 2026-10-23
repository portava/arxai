// Regression guard (Task #367) — the Scanner chart silently went blank for
// every symbol because the candle adapter only read a numeric `time` field, but
// GET /api/chart/candles returns NormalizedChartCandle bars whose time lives in
// ISO `openTime` / `closeTime` strings. Every bar parsed to NaN and was filtered
// out, so a healthy backend still showed "No live candles".
//
// These assertions call the REAL adapter and inspect its output (behavioural,
// not a source-scan), so a future edit that drops the ISO-shape branch fails the
// build instead of silently blanking the chart.

import { describe, it, expect } from "vitest";
import { adaptChartCandles } from "./scannerCandleAdapter.js";

// A minimal NormalizedChartCandle as actually emitted by /api/chart/candles:
// ISO openTime/closeTime strings, NO numeric `time` field.
function normalizedBar(openTimeIso: string, closeTimeIso: string, open: number) {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    openTime: openTimeIso,
    closeTime: closeTimeIso,
    open,
    high: open + 0.001,
    low: open - 0.001,
    close: open + 0.0005,
    volume: 0,
    tickVolume: null,
    source: "mt5_broker",
    sourceMode: "live",
    priceBasis: "BID",
    providerSymbol: "EURUSD",
    brokerSymbol: "EURUSD",
    isComplete: true,
    isFinal: true,
    receivedAt: "2026-06-08T00:00:00.000Z",
    qualityFlags: [],
  } as Record<string, unknown>;
}

describe("adaptChartCandles", () => {
  it("keeps NormalizedChartCandle (ISO openTime/closeTime, no numeric time) bars", () => {
    // Three consecutive M5 bars, the exact shape /api/chart/candles emits.
    const raw = [
      normalizedBar("2026-06-08T00:00:00.000Z", "2026-06-08T00:05:00.000Z", 1.07),
      normalizedBar("2026-06-08T00:05:00.000Z", "2026-06-08T00:10:00.000Z", 1.071),
      normalizedBar("2026-06-08T00:10:00.000Z", "2026-06-08T00:15:00.000Z", 1.072),
    ];

    const out = adaptChartCandles(raw);

    // The whole point of the regression: NONE of these may be dropped.
    expect(out).toHaveLength(3);
    // Every bar resolves to a finite epoch (ms) — never NaN.
    for (const c of out) {
      expect(Number.isFinite(c.time)).toBe(true);
    }
    // Times come from openTime, in epoch milliseconds, chronological order.
    expect(out[0]!.time).toBe(Date.parse("2026-06-08T00:00:00.000Z"));
    expect(out[1]!.time).toBe(Date.parse("2026-06-08T00:05:00.000Z"));
    expect(out[2]!.time).toBe(Date.parse("2026-06-08T00:10:00.000Z"));
    expect(out[0]!.time).toBeLessThan(out[1]!.time);
    expect(out[1]!.time).toBeLessThan(out[2]!.time);
    // OHLC carried through.
    expect(out[0]!.open).toBe(1.07);
  });

  it("falls back to closeTime when openTime is absent", () => {
    const out = adaptChartCandles([
      { closeTime: "2026-06-08T00:05:00.000Z", open: 1.07, high: 1.08, low: 1.06, close: 1.075 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.time).toBe(Date.parse("2026-06-08T00:05:00.000Z"));
  });

  it("keeps legacy/bare bars carrying a numeric time (ms)", () => {
    const t0 = Date.parse("2026-06-08T00:00:00.000Z");
    const t1 = Date.parse("2026-06-08T00:05:00.000Z");
    const out = adaptChartCandles([
      { time: t0, open: 1.07, high: 1.08, low: 1.06, close: 1.075 },
      { time: t1, open: 1.071, high: 1.081, low: 1.061, close: 1.076 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.time).toBe(t0);
    expect(out[1]!.time).toBe(t1);
    expect(out[0]!.time).toBeLessThan(out[1]!.time);
  });

  it("supports the legacy numeric `timestamp` field as a last resort", () => {
    const t0 = Date.parse("2026-06-08T00:00:00.000Z");
    const out = adaptChartCandles([
      { timestamp: new Date(t0).toISOString(), open: 1.07, high: 1.08, low: 1.06, close: 1.075 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.time).toBe(t0);
  });

  it("drops bars that parse to a non-finite time or a non-positive open", () => {
    const out = adaptChartCandles([
      // unparseable time → NaN → dropped
      { openTime: "not-a-date", open: 1.07, high: 1.08, low: 1.06, close: 1.075 },
      // zero open → dropped
      { openTime: "2026-06-08T00:00:00.000Z", open: 0, high: 1.08, low: 1.06, close: 1.075 },
      // valid → kept
      { openTime: "2026-06-08T00:05:00.000Z", open: 1.07, high: 1.08, low: 1.06, close: 1.075 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.time).toBe(Date.parse("2026-06-08T00:05:00.000Z"));
  });

  it("returns an empty array for an empty input", () => {
    expect(adaptChartCandles([])).toEqual([]);
  });
});
