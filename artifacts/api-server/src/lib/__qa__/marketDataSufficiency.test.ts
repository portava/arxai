// ONE DATA-SUFFICIENCY TRUTH (Phase 1) — engine + cross-surface consistency.
//
// Locks the SINGLE closed-bar/freshness verdict that the scanner, Ruby, and the
// chart all consume so they can never contradict each other (the bug: scanner
// shows a confident BUY while Ruby says "candles syncing / cannot verify" for
// the same symbol+timeframe). The engine is pure, so identical inputs ALWAYS
// produce an identical verdict — that equality IS the "one truth" guarantee.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMarketDataSufficiency,
  MIN_SUFFICIENT_CLOSED_BARS,
} from "@workspace/domain/market";

const APPROVED = "EURUSD"; // a known approved ARX focus market
const UNAPPROVED = "ZZZ_NOT_A_MARKET";

test("approved + LIVE + enough closed bars => sufficient, setup may be shown", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 50,
  });
  assert.equal(v.status, "sufficient");
  assert.equal(v.canShowTradeSetup, true);
});

test("approved + LIVE + too few closed bars => insufficient, not shown, honest count", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 4,
  });
  assert.equal(v.status, "insufficient");
  assert.equal(v.canShowTradeSetup, false);
  assert.match(v.humanReason, /candles|bars/i);
  assert.match(v.humanReason, /4/); // surfaces the real shortfall, never fabricates
});

test("unapproved market => blocked, never shown (outranks everything)", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: UNAPPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 999,
  });
  assert.equal(v.status, "blocked");
  assert.equal(v.canShowTradeSetup, false);
  assert.equal(v.isApprovedMarket, false);
});

test("approved + enough bars but DELAYED feed => partial, not shown", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE_DELAYED", availableClosedCandles: 50,
  });
  assert.equal(v.status, "partial");
  assert.equal(v.canShowTradeSetup, false);
});

test("approved + enough bars but AWAITING feed => partial (NOT insufficient)", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "AWAITING", availableClosedCandles: 12,
  });
  assert.equal(v.status, "partial");
  assert.equal(v.canShowTradeSetup, false);
});

test("bar floor OUTRANKS freshness: awaiting + too few bars => insufficient", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "AWAITING", availableClosedCandles: 2,
  });
  assert.equal(v.status, "insufficient");
});

test("boundary: exactly MIN_SUFFICIENT_CLOSED_BARS on a LIVE feed => sufficient", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE",
    availableClosedCandles: MIN_SUFFICIENT_CLOSED_BARS,
  });
  assert.equal(v.status, "sufficient");
  assert.equal(v.canShowTradeSetup, true);
});

test("verdict is DISPLAY-only: exposes canShowTradeSetup, no execution-permission field", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 50,
  });
  const keys = Object.keys(v);
  assert.ok(keys.includes("canShowTradeSetup"));
  for (const forbidden of [
    "tradeSignalAllowed", "tradeExecutionAllowed", "allowOrderExecution",
    "commandExecutionAllowed", "allowExecution", "allowTrade", "canTrade",
  ]) {
    assert.ok(!keys.includes(forbidden), `verdict must not expose an execution field (${forbidden})`);
  }
});

test("ONE TRUTH: scanner-side and Ruby-side derive the IDENTICAL verdict from identical inputs", () => {
  // The contradiction scenario: a live feed but only 3 closed bars. Both the
  // scanner row build and Ruby's chart context feed THIS engine, so they must
  // agree bit-for-bit — neither can show a confident setup the other gates.
  const input = {
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE" as const, availableClosedCandles: 3,
  };
  const scannerVerdict = evaluateMarketDataSufficiency(input);
  const rubyVerdict = evaluateMarketDataSufficiency(input);
  assert.deepEqual(scannerVerdict, rubyVerdict);
  assert.equal(scannerVerdict.canShowTradeSetup, false);
  assert.equal(scannerVerdict.status, "insufficient");
});

// ── Phase 2: display-only readability flags ('direction on insufficient data'
// impossible by construction). Every directional surface keys off these flags;
// locking their derivation here is the single source that makes a confident
// read on thin/stale/blocked data unrepresentable. ──────────────────────────

const DIRECTIONAL_FLAGS = [
  "mayShowBias",
  "mayShowDirection",
  "mayShowTrend",
  "mayShowConfidence",
  "mayShowTradeIdea",
  "mayShowRecommendation",
] as const;

test("sufficient => every directional mayShow* flag is true; reasonCode 'sufficient'", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 50,
  });
  assert.equal(v.reasonCode, "sufficient");
  for (const f of DIRECTIONAL_FLAGS) {
    assert.equal(v[f], true, `${f} must be true when sufficient`);
  }
  assert.equal(v.mayShowReadOnlyContext, true);
});

test("insufficient (1 bar) => NO directional flag; read-only context true; reasonCode 'not_enough_bars'", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 1,
  });
  assert.equal(v.reasonCode, "not_enough_bars");
  for (const f of DIRECTIONAL_FLAGS) {
    assert.equal(v[f], false, `${f} must be false when insufficient`);
  }
  assert.equal(v.mayShowReadOnlyContext, true);
});

test("zero bars => still no direction, honest read-only context only", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 0,
  });
  assert.equal(v.status, "insufficient");
  assert.equal(v.mayShowDirection, false);
  assert.equal(v.mayShowReadOnlyContext, true);
});

test("partial (DELAYED) => directional flags false; reasonCode 'stale_feed'", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "LIVE_DELAYED", availableClosedCandles: 50,
  });
  assert.equal(v.reasonCode, "stale_feed");
  for (const f of DIRECTIONAL_FLAGS) {
    assert.equal(v[f], false, `${f} must be false on a delayed feed`);
  }
  assert.equal(v.mayShowReadOnlyContext, true);
});

test("partial (AWAITING) => directional flags false; reasonCode 'feed_unavailable'", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: APPROVED, timeframe: "M5", freshnessVerdict: "AWAITING", availableClosedCandles: 50,
  });
  assert.equal(v.reasonCode, "feed_unavailable");
  assert.equal(v.mayShowDirection, false);
  assert.equal(v.mayShowReadOnlyContext, true);
});

test("blocked => directional flags false; reasonCode 'source_not_ai_usable'", () => {
  const v = evaluateMarketDataSufficiency({
    symbol: UNAPPROVED, timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 999,
  });
  assert.equal(v.reasonCode, "source_not_ai_usable");
  for (const f of DIRECTIONAL_FLAGS) {
    assert.equal(v[f], false, `${f} must be false when blocked`);
  }
  assert.equal(v.mayShowReadOnlyContext, true);
});

test("reasonCode is a non-empty machine code for EVERY status (matchable across surfaces)", () => {
  const inputs = [
    { symbol: APPROVED, freshnessVerdict: "LIVE" as const, availableClosedCandles: 50 },
    { symbol: APPROVED, freshnessVerdict: "LIVE" as const, availableClosedCandles: 1 },
    { symbol: APPROVED, freshnessVerdict: "LIVE_DELAYED" as const, availableClosedCandles: 50 },
    { symbol: APPROVED, freshnessVerdict: "AWAITING" as const, availableClosedCandles: 50 },
    { symbol: UNAPPROVED, freshnessVerdict: "LIVE" as const, availableClosedCandles: 50 },
  ];
  for (const i of inputs) {
    const v = evaluateMarketDataSufficiency({ ...i, timeframe: "M5" });
    assert.ok(
      typeof v.reasonCode === "string" && v.reasonCode.length > 0,
      `reasonCode must be a non-empty string (status=${v.status})`,
    );
  }
});

test("directional flags NEVER outrun canShowTradeSetup (display gate stays the floor)", () => {
  // A directional flag may only be true when a setup may be shown — proving the
  // flags can hide a read but can never reveal one the display gate forbids.
  for (const bars of [0, 1, 4, 5, 50]) {
    for (const fresh of ["LIVE", "LIVE_DELAYED", "AWAITING"] as const) {
      for (const sym of [APPROVED, UNAPPROVED]) {
        const v = evaluateMarketDataSufficiency({
          symbol: sym, timeframe: "M5", freshnessVerdict: fresh, availableClosedCandles: bars,
        });
        if (!v.canShowTradeSetup) {
          for (const f of DIRECTIONAL_FLAGS) {
            assert.equal(v[f], false, `${f} true while canShowTradeSetup false (${sym}/${fresh}/${bars})`);
          }
        }
      }
    }
  }
});
