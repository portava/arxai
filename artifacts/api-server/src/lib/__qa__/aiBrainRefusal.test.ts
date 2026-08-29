// The Trade Grader refuses instead of grading data it never had.
//
// BEFORE
//   `analyzeMarket` hits a no-data branch for any symbol the simulator does not
//   price, returning entryZone {0,0}, confidence 0 and risk 100. It computed an
//   honest reasonToAvoid ("Symbol not available in simulator.") and then threw
//   it away: `gradeTrade` walked straight into the mistake detector over those
//   zeroes and answered with total confidence — grade "F", "should NOT take",
//   and the specific mistakes "traded against trend", "entered too late",
//   "ignored spread" for a trade nothing had looked at. `entrySniperScore` did
//   the same and returned DO_NOT_ENTER.
//
// AFTER
//   Both refuse: `available: false`, a machine reason, and a human message. No
//   grade, no score, no invented mistakes — and `shouldHaveTakenTrade` is null,
//   not false, because the model has no opinion rather than a negative one.
//
// Run: node --import tsx --test src/lib/__qa__/aiBrainRefusal.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMarket,
  analyzeMarketFromCandles,
  gradeTrade,
  entrySniperScore,
} from "../aiBrain.js";

/** A symbol the simulator has never heard of. */
const UNKNOWN = "ZZZNOTASYMBOL";
/** One the simulator does price. */
const KNOWN = "EURUSD";

const TRADE = { symbol: UNKNOWN, direction: "BUY" as const, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.13 };

test("analyzeMarket flags an unknown symbol as data-unavailable", () => {
  const a = analyzeMarket(UNKNOWN);
  assert.equal(a.dataAvailable, false, "no candles ⇒ dataAvailable must be false");
  assert.equal(a.unavailableReason, "SYMBOL_NOT_IN_SIMULATOR");
});

test("analyzeMarket marks a real simulator read as available", () => {
  const a = analyzeMarket(KNOWN);
  assert.equal(a.dataAvailable, true);
  assert.equal(a.unavailableReason, null);
});

test("the live-feed no-data path reports AWAITING_LIVE_CANDLES, not a simulator reason", () => {
  const a = analyzeMarketFromCandles("EURUSD", "M15", [], { mid: 0, spread: 0 }, "LIVE_FEED");
  assert.equal(a.dataAvailable, false);
  assert.equal(a.unavailableReason, "AWAITING_LIVE_CANDLES");
});

test("gradeTrade REFUSES on a symbol the simulator cannot price", () => {
  const g = gradeTrade(TRADE);
  assert.equal(g.available, false, "must refuse, not grade");
  assert.equal(g.tradeGrade, null, "no letter grade may be emitted");
  assert.equal(g.overallScore, null, "no score may be emitted");
  assert.equal(g.unavailableReason, "SYMBOL_NOT_IN_SIMULATOR");
  assert.ok(
    (g.unavailableMessage ?? "").includes(UNKNOWN),
    "the refusal must name the symbol it could not price",
  );
});

test("a refusal invents no mistakes and takes no side", () => {
  const g = gradeTrade(TRADE);
  assert.deepEqual(g.mistakesDetected, [], "must not accuse the user of mistakes it did not observe");
  assert.deepEqual(g.weaknesses, []);
  assert.deepEqual(g.strengths, []);
  assert.equal(
    g.shouldHaveTakenTrade,
    null,
    "no opinion — NOT `false`, which reads as 'should NOT take'",
  );
});

test("entrySniperScore REFUSES rather than returning DO_NOT_ENTER from nothing", () => {
  const s = entrySniperScore(TRADE);
  assert.equal(s.available, false);
  assert.equal(s.score, null, "null, never a confident 0");
  assert.equal(s.label, null, "no label — DO_NOT_ENTER would be a verdict");
  assert.deepEqual(s.factors, {}, "no factor may be reported over absent data");
  assert.equal(s.unavailableReason, "SYMBOL_NOT_IN_SIMULATOR");
});

test("a known symbol still produces a real graded verdict", () => {
  const g = gradeTrade({ ...TRADE, symbol: KNOWN });
  assert.equal(g.available, true);
  assert.notEqual(g.tradeGrade, null);
  assert.equal(typeof g.overallScore, "number");
  assert.equal(g.unavailableReason, null);
  assert.equal(typeof g.shouldHaveTakenTrade, "boolean");

  const s = entrySniperScore({ ...TRADE, symbol: KNOWN });
  assert.equal(s.available, true);
  assert.equal(typeof s.score, "number");
  assert.notEqual(s.label, null);
});
