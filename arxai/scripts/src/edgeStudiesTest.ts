// Test: the two edge studies (scanner expectancy after costs, vol-scaled
// time-series momentum) measure what they say.
//
// Claims:
//   1. STATISTICS. meanStats and the Bonferroni threshold are right.
//   2. NO LOOKAHEAD. A trend position is decided from bars before the bar it
//      earns; changing a later bar never changes an earlier position.
//   3. POSITIVE CONTROL. A planted persistent trend is found (t well above the
//      corrected threshold); NEGATIVE CONTROL: a driftless random walk is not.
//   4. COSTS BITE. Turnover and financing reduce the net return by exactly the
//      charged amount.
//   5. SCANNER R ARITHMETIC. Every graded scanner call nets its round-trip cost
//      in R, calls never overlap, and zero cost leaves gross == net.
//   6. THE EDGE RULE needs the corrected bound AND a positive later half.
//
// Pure: no DB, no network, no clock.

// The scanner replay imports the app's module graph, which reads DATABASE_URL
// at load. Point it at an unroutable address before loading: nothing connects.
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import assert from "node:assert/strict";
import type { Candle } from "../../artifacts/api-server/src/lib/strategyEngine.js";
import type { ScannerCall, TsmomParams } from "./research/edgeStudies.js";

const { bonferroniZ, equalWeight, expectancyRow, meanStats, performance, scannerCalls, tsmomReturns } = await import("./research/edgeStudies.js");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/** Daily candles from log returns; high/low bracket open/close. */
function candlesFrom(rets: number[], start = 100): Candle[] {
  const out: Candle[] = [];
  let p = start;
  const t0 = Date.UTC(2000, 0, 3);
  for (let k = 0; k < rets.length; k++) {
    const open = p;
    p = p * Math.exp(rets[k]!);
    out.push({ time: new Date(t0 + k * 86_400_000).toISOString(), open, high: Math.max(open, p) * 1.002, low: Math.min(open, p) * 0.998, close: p, volume: 0 });
  }
  return out;
}

const P: TsmomParams = { lookback: 63, volLookback: 63, barsPerYear: 252, targetVolAnnual: 0.1, maxLeverage: 3, costPerTurnover: 0, financingAnnual: 0 };

// 1. Statistics
{
  const s = meanStats([1, 2, 3, 4]);
  assert.equal(s.mean, 2.5);
  assert.ok(Math.abs(s.sd - Math.sqrt(5 / 3)) < 1e-12);
  assert.ok(Math.abs(bonferroniZ(1) - 1.959964) < 1e-3);
  assert.ok(Math.abs(bonferroniZ(10) - 2.807034) < 1e-3);
  assert.ok(bonferroniZ(40) > bonferroniZ(10));
}

// 2. No lookahead
{
  const r = rng(7);
  const c = candlesFrom(Array.from({ length: 400 }, () => 0.01 * gauss(r)));
  const base = tsmomReturns(c, P);
  const k = 300;
  const mutated = c.map((x, j) => (j === k ? { ...x, close: x.close * 1.5, high: x.high * 1.5 } : x));
  const after = tsmomReturns(mutated, P);
  const idx = base.findIndex((x) => x.time === c[k]!.time);
  for (let j = 0; j <= idx; j++) assert.equal(after[j]!.position, base[j]!.position, `position at ${j} must not see bar ${k}`);
}

// 3. Controls
{
  const r = rng(11);
  // Regimes of 500 days with persistent drift ±0.15%/day under 1% noise.
  const rets: number[] = [];
  let drift = 0.0015;
  for (let k = 0; k < 252 * 30; k++) { if (k % 500 === 0) drift = r() < 0.5 ? 0.0015 : -0.0015; rets.push(drift + 0.01 * gauss(r)); }
  const trend = performance(tsmomReturns(candlesFrom(rets), P).map((x) => x.ret), 252);
  assert.ok(trend.t > bonferroniZ(10), `planted trend must be found (t=${trend.t.toFixed(2)})`);

  const r2 = rng(12);
  let worst = 0;
  for (let rep = 0; rep < 5; rep++) {
    const walk = candlesFrom(Array.from({ length: 252 * 30 }, () => 0.01 * gauss(r2)));
    worst = Math.max(worst, Math.abs(performance(tsmomReturns(walk, P).map((x) => x.ret), 252).t));
  }
  assert.ok(worst < bonferroniZ(10), `driftless walk must not pass (max |t|=${worst.toFixed(2)})`);
}

// 4. Costs
{
  const r = rng(3);
  const c = candlesFrom(Array.from({ length: 600 }, () => 0.01 * gauss(r)));
  const gross = tsmomReturns(c, P);
  const net = tsmomReturns(c, { ...P, costPerTurnover: 0.001, financingAnnual: 0.02 });
  let prev = 0;
  for (let j = 0; j < gross.length; j++) {
    const pos = gross[j]!.position;
    const charge = 0.001 * Math.abs(pos - prev) + (0.02 / 252) * Math.abs(pos);
    assert.ok(Math.abs(gross[j]!.ret - charge - net[j]!.ret) < 1e-12);
    prev = pos;
  }
  const ew = equalWeight([[{ time: "a", ret: 1 }, { time: "b", ret: 2 }], [{ time: "b", ret: 4 }]]);
  assert.deepEqual(ew, [{ time: "a", ret: 1 }, { time: "b", ret: 3 }]);
}

// 5. Scanner R arithmetic
{
  const r = rng(5);
  const c = candlesFrom(Array.from({ length: 1500 }, () => 0.004 * gauss(r)), 1.1);
  const free = scannerCalls(c, "EURUSD", "H1", 0);
  const paid = scannerCalls(c, "EURUSD", "H1", 0.0001);
  assert.ok(free.length > 10, `expected scanner calls on a random series, got ${free.length}`);
  assert.equal(paid.length, free.length, "cost never changes which calls are made");
  for (const x of free) assert.equal(x.rNet, x.rGross);
  for (let j = 0; j < paid.length; j++) {
    const x = paid[j]!;
    assert.ok(x.costR > 0);
    assert.ok(Math.abs(x.rNet - (x.rGross - x.costR)) < 1e-12);
    assert.equal(x.rGross, x.win ? x.rewardR : -1);
    if (j > 0) assert.ok(x.i > paid[j - 1]!.i, "calls are in order and never share a bar");
  }
}

// 6. Edge rule
{
  const call = (r: number): ScannerCall => ({ i: 0, direction: "BUY", win: r > 0, rewardR: 1, costR: 0, rGross: r, rNet: r });
  const strong = Array.from({ length: 400 }, (_, k) => call(k % 10 < 6 ? 1 : -1)); // +0.2R mean
  assert.equal(expectancyRow("x", strong, bonferroniZ(10)).edge, true);
  const decaying = [...Array.from({ length: 200 }, () => call(1)), ...Array.from({ length: 200 }, (_, k) => call(k % 10 < 4 ? 1 : -1))];
  assert.equal(expectancyRow("x", decaying, bonferroniZ(10)).edge, false, "a negative later half is never an edge");
  assert.equal(expectancyRow("x", strong.slice(0, 50), bonferroniZ(10)).edge, false, "under 100 calls is never an edge");
}

console.log("edge studies: all claims hold");
process.exit(0);
