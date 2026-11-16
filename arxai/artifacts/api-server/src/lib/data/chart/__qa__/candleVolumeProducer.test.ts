import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../../types.js";
import { normalizeCandles } from "../candleNormalization.js";

const written: Candle[] = [], mirrored: Candle[] = [];
mock.module("../../candleCache.js", { namedExports: {
  isValidCacheOhlc: () => true,
  upsertCandles: async (_s: string, _tf: string, _src: string, rows: Candle[]) => { written.push(...rows); return rows.length; },
} });
mock.module("../../providers/mt5Provider.js", { namedExports: {
  mergeCandleFromMT5: (_s: string, candle: Candle) => { mirrored.push(candle); },
} });
const { ingestMt5CandleHistory } = await import("../../mt5History.js");
const now = Date.parse("2026-11-01T00:00:00Z");
for (const [name, fields, expected] of [
  ["observed zero ticks", { tickVolume: 0, volume: 77 }, "tick_count"],
  ["observed positive ticks", { tickVolume: 17 }, "tick_count"],
  ["missing volume", {}, "unavailable"],
  ["ambiguous numeric volume", { volume: 17 }, "unavailable"],
  ["negative ticks never fall back to numeric volume", { tickVolume: -1, volume: 77 }, "unavailable"],
  ["fractional ticks never fall back to numeric volume", { tickVolume: .5, volume: 77 }, "unavailable"],
] as const) test(`MT5 producer → normalizer: ${name}`, async () => {
  written.length = mirrored.length = 0;
  const input = { time: new Date(now - 60_000).toISOString(), open: 1, high: 2, low: .5, close: 1.5, ...fields };
  const result = await ingestMt5CandleHistory({ symbol: "EURUSD", timeframe: "M1", bars: [input], sentAt: new Date(now).toISOString() }, { now });
  assert.equal(result.accepted, 1);
  assert.equal(written.length, 1); assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0]!.volumeEvidence?.kind, expected);
  const chart = normalizeCandles(mirrored, { symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M1", source: "mt5_broker", now });
  assert.equal(chart.candles[0]!.volumeEvidence?.kind, expected);
  assert.equal(chart.candles[0]!.volumeEvidence?.quantity, expected === "tick_count" && "tickVolume" in fields ? fields.tickVolume : null);
});
