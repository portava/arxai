// Truth regression: assistant chart-structure zones and setup-preview levels
// must be described at the instrument's real price precision. The old
// magnitude heuristic printed 1 decimal for anything >= 1000 (gold, BTC,
// indices) and 4 for forex, so "2380.37 – 2380.92" read "2380.4 – 2380.9" and
// a 1.08523 setup entry was itself rounded to 1.0852.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeChartStructure } from "../chartStructure.js";
import { buildSetupPreview } from "../setupPreview.js";
import type { Candle } from "../../data/types.js";

function series(n: number, start: number, step: number, wick: number, decimals: number): Candle[] {
  const r = (x: number) => Number(x.toFixed(decimals));
  let t = Date.parse("2026-10-27T00:00:00Z");
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = r(start + step * i);
    const open = r(close - step * 0.4);
    t += 5 * 60_000;
    out.push({
      time: new Date(t).toISOString(),
      open,
      high: r(Math.max(open, close) + wick),
      low: r(Math.min(open, close) - wick),
      close,
      volume: 0,
    });
  }
  return out;
}

test("chart structure: gold quoted in cents is not shown in tenths (no symbol precision passed)", () => {
  const candles = series(80, 2380.37, 0.13, 0.27, 2);
  const read = analyzeChartStructure(candles, {});
  assert.equal(read.dataQuality, "ok");
  for (const z of [read.supportZone, read.resistanceZone]) {
    for (const p of z.split(" – ")) {
      assert.match(p, /^\d+\.\d{2}$/, `zone price must carry 2 decimals: ${z}`);
    }
  }
});

test("chart structure: 5-digit forex keeps 5 decimals without a symbol precision", () => {
  const candles = series(80, 1.08523, 0.00011, 0.00017, 5);
  const read = analyzeChartStructure(candles, {});
  for (const p of read.supportZone.split(" – ")) {
    assert.match(p, /^\d\.\d{5}$/, `zone price must carry 5 decimals: ${read.supportZone}`);
  }
});

test("setup preview: EURUSD entry 1.08523 survives (not rounded to 1.0852)", () => {
  const candles = series(80, 1.07643, 0.00011, 0.00017, 5);
  const last = candles[candles.length - 1]!.close;
  assert.equal(last, 1.08512);
  const read = analyzeChartStructure(candles, { pricePrecision: 5 });
  const preview = buildSetupPreview({
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    requestedSide: "BUY",
    read,
    candles,
    basis: "VERIFIED",
    trustLine: "Verified M5 candles",
    providerSource: { assetClass: "forex", composite: false, label: "broker-routed quote" },
    nowMs: Date.parse("2026-10-27T08:00:00Z"),
  });
  assert.ok(preview.levels, `expected levels, got ${preview.verdict}: ${preview.refusalReason}`);
  assert.equal(preview.levels!.entry, 1.08512);
  assert.ok(preview.explanation[0]!.includes("1.08512"), preview.explanation[0]);
});

test("setup preview: XAUUSD levels are described in cents", () => {
  const candles = series(80, 2370.37, 0.13, 0.27, 2);
  const last = candles[candles.length - 1]!.close;
  const read = analyzeChartStructure(candles, { pricePrecision: 2 });
  const preview = buildSetupPreview({
    symbol: "XAUUSD",
    displaySymbol: "XAU/USD",
    timeframe: "M5",
    requestedSide: "BUY",
    read,
    candles,
    basis: "VERIFIED",
    trustLine: "Verified M5 candles",
    providerSource: { assetClass: "metals", composite: false, label: "broker-routed quote" },
    nowMs: Date.parse("2026-10-27T08:00:00Z"),
  });
  assert.ok(preview.levels);
  assert.equal(preview.levels!.entry, last);
  assert.ok(preview.explanation[0]!.includes(last.toFixed(2)), preview.explanation[0]);
});
