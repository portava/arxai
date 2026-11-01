import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeChartStructure, type StructureBias } from "../chartStructure.js";
import type { Candle } from "../../data/types.js";

const rising: Candle[] = Array.from({ length: 60 }, (_, i) => ({ time: new Date(1_700_000_000_000 + i * 60_000).toISOString(), open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 0 }));
for (const [confidence, htfBias] of [["High", "Bullish"], ["Medium", "No clear edge"], ["Low", "Bearish"]] as const) {
  test(`${confidence} structure confidence is not reported as calibrated edge or probability`, () => {
    const read = analyzeChartStructure(rising, { htfBias: htfBias as StructureBias });
    assert.equal(read.confidence, confidence);
    assert.match(read.riskNote, new RegExp(`structural confidence is ${confidence.toLowerCase()}`, "i"));
    assert.doesNotMatch(read.riskNote, /edge|highest.probability|win rate/i);
    assert.equal(read.dataQuality, "ok");
    assert.ok(read.supportZone && read.resistanceZone);
  });
}
