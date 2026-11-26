// When the producer's newest tick may stand in for the newest bar's close
// (Truth audit, 2026-11-25). In 151 live Deriv reads the Truth price was the
// forming bar's close, one tick behind the producer tick in 53 of them, e.g.
// V75 M5: close 46092.5774 while the tick at lastTickAt was 46095.2352.
// Run: node --import tsx --test src/lib/data/chart/__qa__/tickPrice.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { quotePriceOnBasis, tickPriceSupersedingClose } from "../tickPrice.js";

const OPEN = Date.parse("2026-11-25T14:00:00.000Z");
const M5 = 300_000;
const NOW = OPEN + 125_000;
const forming = { openTime: new Date(OPEN).toISOString(), closeTime: new Date(OPEN + M5).toISOString(), close: 46092.5774, isComplete: false };
const closed = { ...forming, openTime: new Date(OPEN - M5).toISOString(), closeTime: new Date(OPEN).toISOString(), isComplete: true };
const tick = (atMs: number, price: number) => ({ atMs, price });

test("measured V75 case: a forming close one tick behind yields the newer tick's price", () => {
  assert.equal(tickPriceSupersedingClose({
    bar: forming, tick: tick(NOW - 1_000, 46095.2352), previousTick: tick(NOW - 3_000, 46092.5774), nowMs: NOW,
  }), 46095.2352);
});

test("the same price as the forming close is bound to the tick's own time", () => {
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: tick(NOW - 1_000, 46092.5774), nowMs: NOW }), 46092.5774);
});

test("an unknown order keeps the close: a different price with no matching previous tick", () => {
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: tick(NOW - 1_000, 46095.2352), nowMs: NOW }), null);
  assert.equal(tickPriceSupersedingClose({
    bar: forming, tick: tick(NOW - 1_000, 46095.2352), previousTick: tick(NOW - 3_000, 46090.1), nowMs: NOW,
  }), null);
  // A previous tick before the bar opened cannot be this bar's close.
  assert.equal(tickPriceSupersedingClose({
    bar: forming, tick: tick(OPEN + 1_000, 46095.2352), previousTick: tick(OPEN - 1_000, 46092.5774), nowMs: NOW,
  }), null);
});

test("a tick before the forming bar opened is older than its close", () => {
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: tick(OPEN - 1, 46092.5774), nowMs: NOW }), null);
});

test("a closed bar: a tick at or after its close supersedes it, an earlier one never does", () => {
  assert.equal(tickPriceSupersedingClose({ bar: closed, tick: tick(OPEN, 46100), nowMs: NOW }), 46100);
  assert.equal(tickPriceSupersedingClose({ bar: closed, tick: tick(NOW - 1, 46100), nowMs: NOW }), 46100);
  assert.equal(tickPriceSupersedingClose({ bar: closed, tick: tick(OPEN - 1, 46092.5774), nowMs: NOW }), null);
});

test("future, non-positive or missing ticks and bars never supersede", () => {
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: tick(NOW + 1, 46095.2352), nowMs: NOW }), null);
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: tick(NOW - 1, 0), nowMs: NOW }), null);
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: tick(Number.NaN, 46095.2352), nowMs: NOW }), null);
  assert.equal(tickPriceSupersedingClose({ bar: forming, tick: null, nowMs: NOW }), null);
  assert.equal(tickPriceSupersedingClose({ bar: null, tick: tick(NOW - 1, 46095.2352), nowMs: NOW }), null);
});

test("an MT5 quote is read on the side the bars declare, never guessed", () => {
  const quote = { bid: 15.25, ask: 31.75, last: 20.5 };
  assert.equal(quotePriceOnBasis(quote, "BID"), 15.25);
  assert.equal(quotePriceOnBasis(quote, "LAST"), 20.5);
  assert.equal(quotePriceOnBasis(quote, "MID"), 23.5);
  for (const basis of ["UNKNOWN", "SYNTHETIC", null, undefined]) assert.equal(quotePriceOnBasis(quote, basis), null);
  assert.equal(quotePriceOnBasis({ ask: 31 }, "BID"), null);
  assert.equal(quotePriceOnBasis({ bid: 15.2 }, "MID"), null);
  assert.equal(quotePriceOnBasis({ bid: 31, ask: 15.2 }, "MID"), null);
});
