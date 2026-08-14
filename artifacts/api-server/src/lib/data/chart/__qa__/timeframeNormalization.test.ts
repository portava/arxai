// Chart timeframe normalization (Task #602).
//
// The read-chart / chart-intelligence paths are canonical-uppercase only. A
// lowercase / TradingView-style timeframe ("15m", "1h", the scanner default)
// forwarded raw used to collapse a perfectly readable chart into a false
// INSUFFICIENT read (the V75 1H "cannot verify" loop). `normalizeChartTimeframe`
// is the single entry-point normalizer; this locks its alias table + the honest
// null for genuinely unsupported strings (callers must NOT silently coerce null).

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeChartTimeframe } from "../timeframes.js";

test("canonical codes pass through unchanged", () => {
  assert.equal(normalizeChartTimeframe("M15"), "M15");
  assert.equal(normalizeChartTimeframe("H1"), "H1");
  assert.equal(normalizeChartTimeframe("W1"), "W1");
  assert.equal(normalizeChartTimeframe("MN1"), "MN1");
});

test("TradingView-style minute/hour aliases map to canonical codes", () => {
  assert.equal(normalizeChartTimeframe("15m"), "M15");
  assert.equal(normalizeChartTimeframe("1h"), "H1");
  assert.equal(normalizeChartTimeframe("4h"), "H4");
  assert.equal(normalizeChartTimeframe("30m"), "M30");
});

test("day / week / month aliases (including bare letters) map canonically", () => {
  assert.equal(normalizeChartTimeframe("1d"), "D1");
  assert.equal(normalizeChartTimeframe("d"), "D1");
  assert.equal(normalizeChartTimeframe("1w"), "W1");
  assert.equal(normalizeChartTimeframe("w"), "W1");
  assert.equal(normalizeChartTimeframe("month"), "MN1");
});

test("casing + surrounding whitespace are tolerated", () => {
  assert.equal(normalizeChartTimeframe("  15M "), "M15");
  assert.equal(normalizeChartTimeframe("m15"), "M15");
});

test("genuinely unsupported strings return null (honest, never coerced)", () => {
  assert.equal(normalizeChartTimeframe("not-a-tf"), null);
  assert.equal(normalizeChartTimeframe(""), null);
  assert.equal(normalizeChartTimeframe("   "), null);
  assert.equal(normalizeChartTimeframe("99x"), null);
});
