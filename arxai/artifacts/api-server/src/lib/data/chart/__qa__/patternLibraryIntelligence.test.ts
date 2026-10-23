// Task #654 — Pattern Library Intelligence Upgrade: OFFLINE pure fixture suite.
//
// Consolidated suite for the expanded Pattern Truth foundation in
// lib/domain/src/market/: the unified detection contract + trade-read classifier
// (patternDetectionContract), the dedicated shooting-star detector
// (shootingStarTruthContract), the candlestick reversals (candlestickReversalContract),
// the consolidation/continuation detector (consolidationTruthContract), the
// structure-break detector (structureBreakContract), the per-asset profiles
// (assetPatternProfile) and Eleanor's reasoning builder (patternReasoning).
//
// It locks the HARD BOUNDARY of Task #654: a detected pattern is EVIDENCE, not
// permission. Every read is pure, deterministic, display-only and downgrade-only;
// nothing here carries an execution-permission field, produces READY_NOW, or can
// override a stale / feed-limited / insufficient feed. Each numbered test maps to
// the spec's Section-13 required behaviours (1–25).
//
// No DB, no live providers — every verdict is built deterministically from fixture
// candles + the caller's already-decided display facts, so the suite runs in the
// offline `ci` lane. Wired as
// `pnpm --filter @workspace/api-server run test:pattern-library-intelligence`.
//
// Run: node --import tsx --test --test-isolation=none \
//   src/lib/data/chart/__qa__/patternLibraryIntelligence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTradeRead,
  isActionableTradeRead,
  resolveShootingStarTruth,
  detectHammer,
  detectEngulfing,
  detectStar,
  resolveConsolidationTruth,
  resolveStructureBreakTruth,
  getAssetPatternProfile,
  classifyAssetClass,
  assetPatternWarnings,
  buildPatternReasoningBlock,
  type TradeReadVerdict,
} from "@workspace/domain/market";
import { buildPatternLibraryRead } from "../patternTruthService.js";
import type { Candle } from "../../types.js";

// ── Fixture helpers ─────────────────────────────────────────────────────────

function bar(open: number, high: number, low: number, close: number) {
  return { open, high, low, close };
}

/** Feed facts: a genuinely live-confirmed, fresh feed. */
const LIVE = { feedConfirmed: true, feedStale: false };
/** Feed facts: delayed/stale feed → reads must be context only. */
const STALE = { feedConfirmed: true, feedStale: true };

/** Five rising closed candles (a prior uptrend) for shooting-star fixtures. */
const UPTREND_5 = [
  bar(0.999, 1.001, 0.998, 1.0),
  bar(1.009, 1.011, 1.008, 1.01),
  bar(1.019, 1.021, 1.018, 1.02),
  bar(1.029, 1.031, 1.028, 1.03),
  bar(1.039, 1.041, 1.038, 1.04),
];

/** Five falling closed candles (a prior downtrend). */
const DOWNTREND_5 = [
  bar(1.041, 1.042, 1.039, 1.04),
  bar(1.031, 1.032, 1.029, 1.03),
  bar(1.021, 1.022, 1.019, 1.02),
  bar(1.011, 1.012, 1.009, 1.01),
  bar(1.001, 1.002, 0.999, 1.0),
];

/** A textbook shooting-star candle (long upper wick, small body near the low). */
const STRONG_STAR = bar(1.04, 1.06, 1.0395, 1.041); // upper/body ratio ~19

// ════════════════════════════════════════════════════════════════════════════
// SHOOTING STAR (1–5)
// ════════════════════════════════════════════════════════════════════════════

// 1. A shooting star only counts AFTER a prior uptrend.
test("1: shooting star requires a prior uptrend", () => {
  const withTrend = resolveShootingStarTruth({
    candles: [...UPTREND_5, STRONG_STAR],
    ...LIVE,
  });
  assert.equal(withTrend.detected, true);
  assert.equal(withTrend.priorUptrend, true);

  const noTrend = resolveShootingStarTruth({
    candles: [...DOWNTREND_5, bar(1.0, 1.02, 0.9995, 1.001)],
    ...LIVE,
  });
  assert.equal(noTrend.detected, false);
});

// 2. Geometry is required: a long UPPER wick + small body near the low.
test("2: shooting star requires the long-upper-wick geometry", () => {
  const notAStar = resolveShootingStarTruth({
    candles: [...UPTREND_5, bar(1.04, 1.045, 1.039, 1.044)], // ordinary bull candle
    ...LIVE,
  });
  assert.equal(notAStar.detected, false);
});

// 3. A shooting star at the last index is UNCONFIRMED (forming) — needs a close.
test("3: shooting star stays forming until the next candle confirms", () => {
  const r = resolveShootingStarTruth({
    candles: [...UPTREND_5, STRONG_STAR],
    ...LIVE,
  });
  assert.equal(r.status, "forming");
  assert.equal(r.direction, "sell");
});

// 4. A shooting star FAILS when the next candle closes above the star's high.
test("4: shooting star fails when price closes back above the wick high", () => {
  const r = resolveShootingStarTruth({
    candles: [...UPTREND_5, STRONG_STAR, bar(1.045, 1.062, 1.044, 1.061)],
    ...LIVE,
  });
  assert.equal(r.status, "failed");
  assert.equal(r.direction, "neutral");
});

// 5. The shooting-star read carries its LOCATION (a rejection at resistance) and
//    a STRONGER rejection scores higher. The dedicated detector models a valid
//    shooting star as inherently a resistance rejection (a long upper wick after
//    an advance IS the rejection), so location is fixed by definition and the
//    rejection STRENGTH is what varies the confidence.
test("5: stronger shooting-star rejection at resistance scores higher", () => {
  const next = bar(1.039, 1.04, 1.037, 1.038); // closes below both stars' lows
  const strong = resolveShootingStarTruth({
    candles: [...UPTREND_5, STRONG_STAR, next],
    ...LIVE,
  });
  const weakStar = bar(1.04, 1.047, 1.0395, 1.042); // ratio ~2.5
  const weak = resolveShootingStarTruth({
    candles: [...UPTREND_5, weakStar, next],
    ...LIVE,
  });
  assert.equal(strong.status, "confirmed");
  assert.equal(weak.status, "confirmed");
  assert.equal(strong.locationQuality, "at_resistance");
  assert.equal(weak.locationQuality, "at_resistance");
  assert.ok(
    strong.confidence > weak.confidence,
    `strong ${strong.confidence} should beat weak ${weak.confidence}`,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// CANDLESTICK REVERSALS (6–8)
// ════════════════════════════════════════════════════════════════════════════

// 6. A hammer is only a hammer after a prior DOWNTREND.
test("6: hammer requires a prior downtrend", () => {
  const hammer = bar(1.001, 1.0025, 0.982, 1.002); // long lower wick, body near high
  const valid = detectHammer({ candles: [...DOWNTREND_5, hammer], ...LIVE });
  assert.equal(valid.detected, true);
  assert.equal(valid.direction, "buy");

  const noTrend = detectHammer({ candles: [...UPTREND_5, hammer], ...LIVE });
  assert.equal(noTrend.detected, false);
});

// 7. Engulfing requires the current body to FULLY engulf the prior body.
test("7: engulfing requires a true body engulf", () => {
  const downLeadIn = [
    bar(1.041, 1.042, 1.039, 1.04),
    bar(1.031, 1.032, 1.029, 1.03),
    bar(1.021, 1.022, 1.019, 1.02),
    bar(1.011, 1.012, 1.009, 1.01),
  ];
  const prevBear = bar(1.012, 1.013, 1.004, 1.005);
  const engulfBull = bar(1.004, 1.017, 1.003, 1.016); // body engulfs prevBear
  const valid = detectEngulfing({
    candles: [...downLeadIn, prevBear, engulfBull],
    ...LIVE,
  });
  assert.equal(valid.detected, true);
  assert.equal(valid.id, "bullish_engulfing");

  const tooSmall = bar(1.006, 1.011, 1.005, 1.01); // body does NOT engulf
  const invalid = detectEngulfing({
    candles: [...downLeadIn, prevBear, tooSmall],
    ...LIVE,
  });
  assert.equal(invalid.detected, false);
});

// 8. Morning/evening stars need the full THREE-candle structure (>= 7 candles).
test("8: morning star requires the three-candle structure", () => {
  const downLeadIn = [
    bar(1.061, 1.062, 1.059, 1.06),
    bar(1.051, 1.052, 1.049, 1.05),
    bar(1.041, 1.042, 1.039, 1.04),
    bar(1.031, 1.032, 1.029, 1.03),
  ];
  const a = bar(1.03, 1.031, 1.008, 1.01); // strong down
  const mid = bar(1.011, 1.015, 1.009, 1.013); // small indecision
  const c = bar(1.012, 1.029, 1.011, 1.028); // strong up into first body
  const valid = detectStar({ candles: [...downLeadIn, a, mid, c], ...LIVE });
  assert.equal(valid.detected, true);
  assert.equal(valid.id, "morning_star");

  const tooFew = detectStar({ candles: [a, mid, c, a, mid, c], ...LIVE });
  assert.equal(tooFew.detected, false);
  assert.equal(tooFew.status, "none");
});

// ════════════════════════════════════════════════════════════════════════════
// CONSOLIDATION / CONTINUATION (9–14)
// ════════════════════════════════════════════════════════════════════════════

/** 12 closed window candles: flat highs (1.100), rising lows → ascending triangle. */
function ascendingTriangleWindow() {
  const w = [];
  for (let i = 0; i < 12; i++) {
    const low = 1.082 + 0.0008 * i;
    w.push(bar(1.091, 1.1, low, 1.092));
  }
  return w;
}

// 9. A triangle that has NOT broken out is still a WAIT (forming).
test("9: triangle forming remains a wait", () => {
  const r = resolveConsolidationTruth({
    candles: [...ascendingTriangleWindow(), bar(1.094, 1.099, 1.093, 1.095)],
    ...LIVE,
  });
  assert.equal(r.type, "ascending_triangle");
  assert.equal(r.status, "forming");
});

// 10. A breakout requires a CLOSE beyond the boundary — an intrabar poke is not it.
test("10: breakout requires a close beyond the boundary, not a wick", () => {
  const breakout = resolveConsolidationTruth({
    candles: [...ascendingTriangleWindow(), bar(1.099, 1.103, 1.098, 1.102)],
    ...LIVE,
  });
  assert.equal(breakout.status, "confirmed");
  assert.equal(breakout.direction, "buy");

  const poke = resolveConsolidationTruth({
    candles: [...ascendingTriangleWindow(), bar(1.098, 1.102, 1.097, 1.099)],
    ...LIVE,
  });
  assert.equal(poke.status, "forming");
  assert.ok(
    poke.reasons.some((x) => /pierced .* did NOT close/i.test(x)),
    "should explain the intrabar poke did not close beyond the boundary",
  );
});

/** Strong up impulse (pole) then a tight pullback (flag) → bull flag. */
function bullFlagBase() {
  const pole = [
    bar(0.999, 1.001, 0.998, 1.0),
    bar(1.009, 1.011, 1.008, 1.01),
    bar(1.019, 1.021, 1.018, 1.02),
    bar(1.029, 1.031, 1.028, 1.03),
  ];
  const flag = [
    bar(1.03, 1.032, 1.028, 1.03),
    bar(1.03, 1.032, 1.028, 1.0295),
    bar(1.0295, 1.0315, 1.0285, 1.029),
    bar(1.029, 1.031, 1.028, 1.0288),
    bar(1.0288, 1.0308, 1.0278, 1.0285),
    bar(1.0285, 1.0305, 1.0275, 1.0283),
    bar(1.0283, 1.0303, 1.0273, 1.028),
    bar(1.028, 1.03, 1.027, 1.0285),
  ];
  return [...pole, ...flag];
}

// 11. A flag is a continuation only when there is a prior IMPULSE (the pole).
test("11: flag continuation requires a prior impulse", () => {
  const withImpulse = resolveConsolidationTruth({
    candles: [...bullFlagBase(), bar(1.0285, 1.0305, 1.0275, 1.029)],
    ...LIVE,
  });
  assert.equal(withImpulse.type, "bull_flag");
  assert.equal(withImpulse.direction, "buy");
  assert.equal(withImpulse.status, "forming");

  // Same tight drift but with a FLAT lead-in (no pole) → not a flag.
  const flat = [];
  for (let i = 0; i < 4; i++) flat.push(bar(1.029, 1.031, 1.028, 1.03));
  const noImpulse = resolveConsolidationTruth({
    candles: [
      ...flat,
      ...bullFlagBase().slice(4),
      bar(1.0285, 1.0305, 1.0275, 1.029),
    ],
    ...LIVE,
  });
  assert.notEqual(noImpulse.type, "bull_flag");
  assert.notEqual(noImpulse.type, "bear_flag");
});

// 12. A flag FAILURE (resolving against the pole) invalidates the continuation.
test("12: flag failure invalidates the continuation thesis", () => {
  const failed = resolveConsolidationTruth({
    candles: [...bullFlagBase(), bar(1.028, 1.029, 1.0255, 1.026)],
    ...LIVE,
  });
  assert.equal(failed.type, "bull_flag");
  assert.equal(failed.status, "confirmed");
  assert.equal(failed.direction, "sell"); // bullish continuation invalidated
  assert.ok(
    failed.reasons.some((x) => /invalidated|AGAINST the pole/i.test(x)),
    "should state the flag resolved against the pole",
  );
});

/** 12 window candles: flat highs (1.100) AND flat lows (1.080) → rectangle range. */
function rectangleWindow() {
  const w = [];
  for (let i = 0; i < 12; i++) w.push(bar(1.088, 1.1, 1.08, 1.09));
  return w;
}

// 13. A rectangle mid-range is a NO-TRADE (consolidation, never buy/sell).
test("13: rectangle mid-range is a no-trade", () => {
  const r = resolveConsolidationTruth({
    candles: [...rectangleWindow(), bar(1.089, 1.099, 1.081, 1.09)],
    ...LIVE,
  });
  assert.equal(r.type, "rectangle_range");
  assert.equal(r.location, "mid_range");

  const verdict = classifyTradeRead({
    family: "consolidation",
    direction: r.direction,
    status: r.status === "none" ? "forming" : r.status,
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    scalpTimingOk: true,
    spreadAcceptable: true,
  });
  assert.equal(verdict.tradeRead, "consolidation");
  assert.equal(isActionableTradeRead(verdict.tradeRead), false);
});

// 14. A range EDGE alone is not a break — it still needs a confirming close.
test("14: range edge requires confirmation", () => {
  const r = resolveConsolidationTruth({
    candles: [...rectangleWindow(), bar(1.097, 1.0995, 1.096, 1.099)],
    ...LIVE,
  });
  assert.equal(r.location, "at_resistance");
  assert.equal(r.status, "forming"); // touching the edge ≠ a confirmed break
});

// ════════════════════════════════════════════════════════════════════════════
// STRUCTURE BREAKS (15–16)
// ════════════════════════════════════════════════════════════════════════════

/** 11 prior candles forming a falling resistance / support channel. */
function fallingChannelPrior() {
  const w = [];
  for (let i = 0; i < 11; i++) {
    const high = 1.11 - 0.001 * i;
    const low = 1.09 - 0.001 * i;
    w.push(bar((high + low) / 2, high, low, (high + low) / 2));
  }
  return w; // projHigh at index 11 ≈ 1.099, projLow ≈ 1.079
}

// 15. A trendline break is only valid on a CLOSE — a wick poke is not a break.
test("15: trendline break requires a close, not a wick", () => {
  const broke = resolveStructureBreakTruth({
    candles: [...fallingChannelPrior(), bar(1.098, 1.103, 1.097, 1.101)],
    ...LIVE,
  });
  assert.equal(broke.type, "trendline_break");
  assert.equal(broke.status, "confirmed");
  assert.equal(broke.brokeOnClose, true);

  const wick = resolveStructureBreakTruth({
    candles: [...fallingChannelPrior(), bar(1.098, 1.103, 1.097, 1.0985)],
    ...LIVE,
  });
  assert.equal(wick.status, "failed");
  assert.equal(wick.brokeOnClose, false);
});

// 16. A support/resistance flip is a forming RETEST, never an instant entry.
test("16: support/resistance flip requires a retest", () => {
  // Rise to a resistance peak, close near it (the break), then the last candle
  // retests that level from above (low touches it, close holds above).
  const prior = [
    bar(1.09, 1.0915, 1.0885, 1.091),
    bar(1.091, 1.0925, 1.0895, 1.092),
    bar(1.092, 1.0935, 1.0905, 1.093),
    bar(1.093, 1.0945, 1.0915, 1.094),
    bar(1.094, 1.0955, 1.0925, 1.095),
    bar(1.095, 1.0965, 1.0935, 1.096),
    bar(1.096, 1.0975, 1.0945, 1.097),
    bar(1.097, 1.0985, 1.0955, 1.098),
    bar(1.0975, 1.099, 1.096, 1.0985),
    bar(1.097, 1.0985, 1.0955, 1.098),
    bar(1.0965, 1.098, 1.095, 1.097),
  ];
  const last = bar(1.0975, 1.0992, 1.0985, 1.0989); // retest of ~1.099 from above
  const r = resolveStructureBreakTruth({ candles: [...prior, last], ...LIVE });
  assert.equal(r.type, "support_resistance_flip");
  assert.equal(r.status, "forming");
  assert.ok(
    r.reasons.some((x) => /retest|flip/i.test(x)),
    "should describe the level being retested as a flip",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION SAFETY (17–18, 22–24)
// ════════════════════════════════════════════════════════════════════════════

const FULL_GO = {
  feedConfirmed: true,
  feedStale: false,
  sufficiencyAllowsSetup: true,
  scalpTimingOk: true,
  spreadAcceptable: true,
};

// 17. Consolidation suppresses aggressive trade labels even when "confirmed".
test("17: consolidation suppresses aggressive trade labels", () => {
  const v = classifyTradeRead({
    family: "consolidation",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
  });
  assert.equal(v.tradeRead, "consolidation");
  assert.equal(isActionableTradeRead(v.tradeRead), false);
});

// 18. A scalp read requires acceptable timing AND spread.
test("18: scalp setup requires timing and spread approval", () => {
  const ok = classifyTradeRead({
    family: "scalp",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
  });
  assert.equal(ok.tradeRead, "scalp");

  const badTiming = classifyTradeRead({
    family: "scalp",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
    scalpTimingOk: false,
  });
  assert.equal(badTiming.tradeRead, "no_trade");

  const badSpread = classifyTradeRead({
    family: "scalp",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
    spreadAcceptable: false,
  });
  assert.equal(badSpread.tradeRead, "no_trade");
});

// ════════════════════════════════════════════════════════════════════════════
// ASSET PROFILES (19–21)
// ════════════════════════════════════════════════════════════════════════════

// 19. Synthetic pattern stats aggregate into a SEPARATE bucket from forex/indices.
test("19: synthetic pattern stats stay separate from forex", () => {
  assert.equal(getAssetPatternProfile("synthetic").statsBucket, "synthetic");
  assert.equal(getAssetPatternProfile("forex").statsBucket, "forex_indices");
  assert.notEqual(
    getAssetPatternProfile("synthetic").statsBucket,
    getAssetPatternProfile("forex").statsBucket,
  );
  assert.equal(classifyAssetClass("Volatility 75 Index"), "synthetic");
  assert.equal(classifyAssetClass("R_100"), "synthetic");
  assert.equal(classifyAssetClass("EURUSD"), "forex");
});

// 20. Gold's high-volatility caveat downgrades tight-stop reads.
test("20: gold high-volatility warning downgrades reads", () => {
  assert.equal(getAssetPatternProfile("gold").volatility, "high");
  assert.equal(getAssetPatternProfile("forex").volatility, "medium");
  const w = assetPatternWarnings({ assetClass: "gold" });
  assert.ok(w.length > 0);
  assert.ok(w.some((x) => /whipsaw|wider stops|false break/i.test(x)));
  const news = assetPatternWarnings({
    assetClass: "gold",
    nearHighImpactNews: true,
  });
  assert.ok(news.length > w.length, "near-news adds a downgrade caveat");
});

// 21. US30 (an index) opening-range timing caveat downgrades scalps.
test("21: US30 opening-range timing warning downgrades scalp", () => {
  assert.equal(classifyAssetClass("US30"), "indices");
  const base = assetPatternWarnings({ assetClass: "indices" });
  const atOpen = assetPatternWarnings({
    assetClass: "indices",
    atOpeningRange: true,
  });
  assert.ok(atOpen.length > base.length);
  assert.ok(atOpen.some((x) => /opening-range|whipsaw|trap/i.test(x)));
});

// 22. Backtest/historical success can NEVER, on its own, create a READY_NOW grant.
//     Reliability is not even an input to the classifier, and the verdict carries
//     no ready/execute/dispatch/grant field by construction.
test("22: backtest success cannot create READY_NOW alone", () => {
  const v = classifyTradeRead({
    family: "reversal",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
  });
  assert.deepEqual(
    Object.keys(v).sort(),
    ["conditional", "contextOnly", "reasons", "tradeRead"],
  );
  for (const k of Object.keys(v)) {
    assert.ok(
      !/ready|execute|dispatch|permit|grant/i.test(k),
      `verdict must not expose an execution key (${k})`,
    );
  }
  assert.notEqual(v.tradeRead as string, "READY_NOW");
});

// 23. Forward-test success cannot bypass a non-live feed — context only.
test("23: forward-test success cannot bypass live gates", () => {
  const v = classifyTradeRead({
    family: "reversal",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
    feedConfirmed: false, // feed NOT live-confirmed
  });
  assert.equal(v.contextOnly, true);
  assert.equal(isActionableTradeRead(v.tradeRead), false);
});

// 24. A pattern cannot override a stale / feed-limited status.
test("24: pattern cannot override stale/feed-limited status", () => {
  const v = classifyTradeRead({
    family: "reversal",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
    feedStale: true,
  });
  assert.equal(v.contextOnly, true);
  assert.equal(isActionableTradeRead(v.tradeRead), false);

  // The dedicated shooting-star detector likewise caps to context on a stale feed.
  const star = resolveShootingStarTruth({
    candles: [...UPTREND_5, STRONG_STAR],
    ...STALE,
  });
  assert.equal(star.contextOnly, true);
  assert.ok(star.confidence <= 35, `stale confidence ${star.confidence} must be capped`);
});

// ════════════════════════════════════════════════════════════════════════════
// ELEANOR REASONING (25)
// ════════════════════════════════════════════════════════════════════════════

// 25. Eleanor's reasoning block always states CONFIRMATION + INVALIDATION and
//     never leaks an internal enum token or a READY_NOW grant.
test("25: reasoning block includes confirmation and invalidation, no token leak", () => {
  const read: TradeReadVerdict = classifyTradeRead({
    family: "reversal",
    direction: "buy",
    status: "confirmed",
    ...FULL_GO,
  });
  const block = buildPatternReasoningBlock({
    symbol: "EURUSD",
    read,
    detection: null,
  });
  assert.deepEqual(
    Object.keys(block).sort(),
    [
      "confirmation",
      "decision",
      "evidence",
      "invalidation",
      "riskNote",
      "traderTest",
      "why",
    ],
  );
  assert.ok(block.confirmation.length > 0);
  assert.ok(block.invalidation.length > 0);
  assert.ok(/confirm/i.test(block.confirmation));
  assert.ok(/invalidat/i.test(block.invalidation));

  const prose = [
    block.decision,
    block.why,
    ...block.evidence,
    block.confirmation,
    block.invalidation,
    block.traderTest,
    block.riskNote,
  ].join(" ");
  assert.ok(!/ready now|READY_NOW/i.test(prose), "must never imply ready now");
  assert.ok(
    !/\b[A-Z]{3,}_[A-Z]{3,}\b/.test(prose),
    "must not leak UPPER_SNAKE enum tokens",
  );
});

// ── Additive composition: buildPatternLibraryRead (Task #654 T007) ───────────
//
// These lock the api-server-side composition that folds the expanded foundation
// into ONE display-only read on the production market-intelligence path. It must
// stay pure, fail-closed, evidence-only and downgrade-only: never actionable off
// a non-live feed, and never carrying an execution-permission field.

/**
 * Map OHLC fixtures to typed Candles with monotonic, past-dated, ISO-8601 M15
 * timestamps (normalizeCandles parses `time` via Date.parse, so epoch strings are
 * rejected — it must be ISO). 2024 dates keep every bar safely in the past.
 */
function toCandles(rows: ReturnType<typeof bar>[]): Candle[] {
  const baseMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const stepMs = 15 * 60 * 1000;
  return rows.map((r, i) => ({
    time: new Date(baseMs + i * stepMs).toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }));
}

const PERMISSION_KEY =
  /^(ready|readyNow|allowExecution|executionAllowed|commandExecutionAllowed|canExecute|canTrade|canDispatch|dispatch|permission|allowOrderExecution|liveLocked|brokerPlacementImplemented)$/i;

/** Recursively assert no node carries an execution-permission-shaped key. */
function assertNoPermissionField(value: unknown, path = "root"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPermissionField(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assert.ok(
      !PERMISSION_KEY.test(k),
      `pattern library read must not carry an execution-permission field: ${path}.${k}`,
    );
    assertNoPermissionField(v, `${path}.${k}`);
  }
}

// 26. Fail-closed: empty candles or an unsupported timeframe yield no read.
test("26: pattern library read fails closed on bad input", () => {
  assert.equal(
    buildPatternLibraryRead({
      symbol: "EURUSD",
      timeframe: "M15",
      rawCandles: [],
      feedConfirmed: true,
      feedStale: false,
      sufficiencyAllowsSetup: true,
    }),
    null,
  );
  assert.equal(
    buildPatternLibraryRead({
      symbol: "EURUSD",
      timeframe: "not-a-timeframe",
      rawCandles: toCandles([...bullFlagBase(), bar(1.0285, 1.0305, 1.0275, 1.029)]),
      feedConfirmed: true,
      feedStale: false,
      sufficiencyAllowsSetup: true,
    }),
    null,
  );
});

// 27. A live flag composes into a structured, evidence-only read with reasoning.
test("27: pattern library read composes a live structure into evidence", () => {
  const read = buildPatternLibraryRead({
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M15",
    rawCandles: toCandles([...bullFlagBase(), bar(1.0285, 1.0305, 1.0275, 1.029)]),
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
  });
  assert.ok(read, "a detectable flag should yield a library read");
  assert.equal(read.consolidation.type, "bull_flag");
  assert.equal(read.assetClass, "forex");
  assert.equal(read.profile.assetClass, "forex");
  assert.ok(read.reasoning.confirmation.length > 0);
  assert.ok(read.reasoning.invalidation.length > 0);
  assertNoPermissionField(read);
});

// 28. Off a non-live feed the read can NEVER be actionable (downgrade-only).
test("28: pattern library read is never actionable off a non-live feed", () => {
  for (const feed of [
    { feedConfirmed: false, feedStale: false },
    { feedConfirmed: true, feedStale: true },
  ]) {
    const read = buildPatternLibraryRead({
      symbol: "EURUSD",
      timeframe: "M15",
      rawCandles: toCandles([...bullFlagBase(), bar(1.0285, 1.0305, 1.0275, 1.029)]),
      ...feed,
      sufficiencyAllowsSetup: true,
    });
    // Either no read at all, or a strictly context-only / non-actionable read.
    if (read) {
      assert.equal(isActionableTradeRead(read.read.tradeRead), false);
      assert.equal(read.read.contextOnly, true);
      assertNoPermissionField(read);
    }
  }
});

// 29. When sufficiency forbids a setup, the read stays context-only.
test("29: pattern library read respects sufficiency (context-only when blocked)", () => {
  const read = buildPatternLibraryRead({
    symbol: "EURUSD",
    timeframe: "M15",
    rawCandles: toCandles([...bullFlagBase(), bar(1.0285, 1.0305, 1.0275, 1.029)]),
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: false,
  });
  if (read) {
    assert.equal(isActionableTradeRead(read.read.tradeRead), false);
    assert.equal(read.read.contextOnly, true);
    assertNoPermissionField(read);
  }
});

// ── Multi-family composition (Task #654 T007 core fix) ───────────────────────
//
// The builder must compose EVERY detector family, not just consolidation. These
// lock that a candlestick reversal or a structure break — with NO consolidation
// structure present (the OLD builder returned null here) — now yields a unified,
// classified, evidence-only read.

// 30. A confirmed shooting star with NO consolidation present still reads.
test("30: pattern library read composes a candlestick family (no consolidation)", () => {
  const read = buildPatternLibraryRead({
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M15",
    // A prior uptrend + a strong shooting star + a confirming down close: the
    // consolidation detector finds NO range/flag here, so this fired ONLY because
    // the candlestick family is now composed.
    rawCandles: toCandles([...UPTREND_5, STRONG_STAR, bar(1.039, 1.04, 1.037, 1.038)]),
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
  });
  assert.ok(read, "a confirmed shooting star should yield a library read");
  assert.equal(read.consolidation.type, "none");
  assert.equal(read.detection.family, "candlestick");
  assert.equal(read.detection.direction, "sell");
  assert.equal(read.detection.status, "confirmed");
  assert.ok(read.candidates.length >= 1);
  assert.ok(read.reasoning.confirmation.length > 0);
  assert.ok(read.reasoning.invalidation.length > 0);
  assertNoPermissionField(read);
});

// 31. A confirmed structure break outranks a co-present forming consolidation.
test("31: structure break outranks a co-present forming consolidation", () => {
  const fallingChannelPrior = () => {
    const w: ReturnType<typeof bar>[] = [];
    for (let i = 0; i < 11; i++) {
      const high = 1.11 - 0.001 * i;
      const low = 1.09 - 0.001 * i;
      w.push(bar((high + low) / 2, high, low, (high + low) / 2));
    }
    return w;
  };
  const read = buildPatternLibraryRead({
    symbol: "EURUSD",
    timeframe: "M15",
    rawCandles: toCandles([...fallingChannelPrior(), bar(1.098, 1.103, 1.097, 1.101)]),
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
  });
  assert.ok(read, "a confirmed trendline break should yield a library read");
  // A forming consolidation IS present, but the confirmed structure break is the
  // stronger structure and must lead the read.
  assert.notEqual(read.consolidation.type, "none");
  assert.equal(read.detection.family, "structure");
  assert.equal(read.detection.status, "confirmed");
  assert.ok(
    read.candidates.some((c) => c.family === "consolidation" || c.family === "continuation"),
    "the co-present consolidation must still appear as a candidate",
  );
  assertNoPermissionField(read);
});

// 32. Even a fully composed multi-family read stays NON-actionable off a non-live
//     feed (downgrade-only holds across every family).
test("32: composed multi-family read is never actionable off a non-live feed", () => {
  const read = buildPatternLibraryRead({
    symbol: "EURUSD",
    timeframe: "M15",
    rawCandles: toCandles([...UPTREND_5, STRONG_STAR, bar(1.039, 1.04, 1.037, 1.038)]),
    feedConfirmed: false,
    feedStale: false,
    sufficiencyAllowsSetup: true,
  });
  if (read) {
    assert.equal(isActionableTradeRead(read.read.tradeRead), false);
    assert.equal(read.read.contextOnly, true);
    assertNoPermissionField(read);
  }
});

// 33. Candidate ranking is fully deterministic and stably ordered: identical
//     inputs compose to a byte-identical candidate order and primary, and every
//     adjacent candidate pair already honours the rank precedence
//     (status -> confidence -> family -> id). Protects primary-selection
//     stability for co-present, equally-graded structures.
test("33: composed candidate ranking is deterministic and stably ordered", () => {
  const fallingChannelPriorRows = () => {
    const w: ReturnType<typeof bar>[] = [];
    for (let i = 0; i < 11; i++) {
      const high = 1.11 - 0.001 * i;
      const low = 1.09 - 0.001 * i;
      w.push(bar((high + low) / 2, high, low, (high + low) / 2));
    }
    return w;
  };
  const input = {
    symbol: "EURUSD",
    timeframe: "M15" as const,
    rawCandles: toCandles([...fallingChannelPriorRows(), bar(1.098, 1.103, 1.097, 1.101)]),
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
  };
  const a = buildPatternLibraryRead(input);
  const b = buildPatternLibraryRead(input);
  assert.ok(a && b, "a multi-family fixture should compose a library read");
  assert.ok(a.candidates.length >= 2, "fixture must surface at least two candidates");
  // Pure + deterministic: identical inputs ⇒ byte-identical candidate ordering.
  assert.deepEqual(
    a.candidates.map((c) => c.id),
    b.candidates.map((c) => c.id),
    "identical inputs must produce an identical candidate order",
  );
  assert.equal(a.detection.id, b.detection.id, "primary selection must be stable");
  assert.equal(a.detection.id, a.candidates[0].id, "primary is always candidates[0]");
  // Stable ordering: every adjacent pair already respects the rank precedence.
  const statusOrder: Record<string, number> = {
    confirmed: 3,
    waiting_confirmation: 2,
    forming: 1,
    invalidated: 0,
  };
  const familyOrder: Record<string, number> = {
    structure: 5,
    reversal: 4,
    consolidation: 3,
    continuation: 2,
    candle: 1,
  };
  for (let i = 0; i + 1 < a.candidates.length; i++) {
    const hi = a.candidates[i];
    const lo = a.candidates[i + 1];
    const hiKey = [
      statusOrder[hi.status] ?? -1,
      hi.confidence,
      familyOrder[hi.family] ?? -1,
    ];
    const loKey = [
      statusOrder[lo.status] ?? -1,
      lo.confidence,
      familyOrder[lo.family] ?? -1,
    ];
    const precedes =
      hiKey[0] > loKey[0] ||
      (hiKey[0] === loKey[0] && hiKey[1] > loKey[1]) ||
      (hiKey[0] === loKey[0] &&
        hiKey[1] === loKey[1] &&
        hiKey[2] > loKey[2]) ||
      (hiKey[0] === loKey[0] &&
        hiKey[1] === loKey[1] &&
        hiKey[2] === loKey[2] &&
        hi.id.localeCompare(lo.id) <= 0);
    assert.ok(
      precedes,
      `candidate ${hi.id} must rank at or above ${lo.id} by the documented precedence`,
    );
  }
  assertNoPermissionField(a);
});
