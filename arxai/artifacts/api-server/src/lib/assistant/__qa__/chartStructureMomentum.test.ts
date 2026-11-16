// Owner screenshot 2026-10-27 (V75 1m, Deriv public data): Eleanor's chart read
// put "Read confidence Low." in the MOMENTUM row. That confidence is the chart
// read's three-level STRUCTURE scale (bias × timeframe agreement × momentum
// strength), not a momentum fact, and it sat on the same page as the market-edge
// card's "Trade quality 42/100". This locks: the analyzer emits a measured
// momentum sentence (direction and size of the last bars' move against the
// average bar range), separate from the structure confidence.
//
// Run:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/assistant/__qa__/chartStructureMomentum.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeChartStructure } from "../chartStructure.js";
import type { Candle } from "../../data/types.js";

const T0 = Date.parse("2026-10-27T14:00:00Z");

function bars(steps: number[]): Candle[] {
  let p = 33000;
  return steps.map((d, i) => {
    const open = p;
    const close = p + d;
    p = close;
    return {
      time: new Date(T0 + i * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 4,
      low: Math.min(open, close) - 4,
      close,
    };
  });
}

test("owner shape: trend up into resistance with momentum cooling → Mixed / Low, momentum measured separately", () => {
  // 70 bars climbing, then 10 near-flat bars at the top of the range.
  const steps = [...Array(70).fill(8), ...Array(10).fill(0.2)];
  const read = analyzeChartStructure(bars(steps));
  assert.equal(read.bias, "Mixed");
  assert.equal(read.confidence, "Low");
  assert.ok(read.momentumNote, "momentum sentence is emitted");
  assert.match(read.momentumNote!, /^Momentum cooling: the last 5 bars moved \+0\.\d× the average bar range \(14-bar\); price is trading up near resistance\.$/);
  assert.doesNotMatch(read.momentumNote!, /confidence/i);
});

test("strong upside push → names upside momentum with its measured size", () => {
  const steps = [...Array(60).fill(0.5), ...Array(5).fill(30)];
  const read = analyzeChartStructure(bars(steps));
  assert.match(read.momentumNote!, /^Upside momentum: the last 5 bars moved \+\d+\.\d× the average bar range/);
});

test("strong downside push → names downside momentum", () => {
  const steps = [...Array(60).fill(-0.5), ...Array(5).fill(-30)];
  const read = analyzeChartStructure(bars(steps));
  assert.match(read.momentumNote!, /^Downside momentum: the last 5 bars moved −\d+\.\d× /);
});

test("too few bars → momentum is said to be not read (never a confidence word)", () => {
  const read = analyzeChartStructure(bars(Array(10).fill(1)));
  assert.equal(read.dataQuality, "insufficient");
  assert.equal(read.momentumNote, "Momentum not read — not enough candle history on this timeframe.");
});
