// THEME A2 — the inline blind flame read must be as honest as its sibling.
//
// `readFlame` takes a BLIND branch when there is no usable candle window. That
// branch used to emit:
//   entryTiming: "ACCEPTABLE"   ← a green light derived from nothing
//   runway:      runwayFor(..., args.point * 50)
//                               ← a runway measured against an INVENTED ATR
//                                 (50 points, a constant, not observed volatility)
// while the sibling `blindFlameRead()` — same "no candles" condition — honestly
// returns NO_ENTRY / NO_SCALP / runway NONE.
//
// The divergence was load-bearing, not cosmetic: `finalizeScalpVerdict` treats
// ACCEPTABLE as `goodTiming`, so a blind read could be promoted to POSSIBLE or
// STRONG, and it special-cased blind reads to carry that timing through the
// non-actionable path untouched.
//
// Contract: with no candles, the read is NO_ENTRY / NO_SCALP with runway NONE,
// and no evaluation of it can surface an actionable verdict.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFlame, blindFlameRead, finalizeScalpVerdict } from "../flameRead.js";
import type { FlameReadArgs } from "../flameRead.js";
import type { ScalpCandle } from "../scalpTypes.js";

/**
 * Geometry with a WIDE main target and an early lateFraction — i.e. the exact
 * shape that made the old blind branch report a CLEAR/MODERATE runway off the
 * fabricated `point * 50` ATR. If the fix works, none of it matters: with no
 * candles there is no observed volatility to measure runway against.
 */
function args(overrides: Partial<FlameReadArgs> = {}): FlameReadArgs {
  return {
    direction: "BUY",
    candles: null,
    price: 1.1,
    point: 0.0001,
    spreadPrice: 0.00008,
    stopDist: 0.0015,
    mainTpDist: 0.0045,
    quickTpDist: 0.002,
    lateFraction: 0.1,
    inZone: true,
    execution: null,
    htfBias: "bullish",
    personality: "AGGRESSIVE",
    scannerReason: "Momentum breakout on the scanner",
    scannerSetupType: "BREAKOUT",
    invalidationPrice: 1.0985,
    quickTpPrice: 1.102,
    mainTpPrice: 1.1045,
    digits: 5,
    ...overrides,
  };
}

function candle(i: number): ScalpCandle {
  const base = 1.1 + i * 0.0002;
  return { open: base, high: base + 0.0003, low: base - 0.0001, close: base + 0.0002 };
}

describe("A2 — readFlame's blind branch is honest", () => {
  it("returns NO_ENTRY, not ACCEPTABLE, when candles are null", () => {
    const core = readFlame(args());
    assert.equal(core.blind, true);
    assert.equal(core.read.entryTiming, "NO_ENTRY");
  });

  it("never synthesizes a runway from an invented ATR", () => {
    const core = readFlame(args());
    assert.equal(
      core.read.runway,
      "NONE",
      "a blind read has no observed volatility — any runway grade is fabricated",
    );
  });

  it("reads NO_SCALP / NOT_A_SCALP like the sibling blind read", () => {
    const core = readFlame(args());
    assert.equal(core.read.readDirection, "NO_SCALP");
    assert.equal(core.read.scalpStatus, "NOT_A_SCALP");
    assert.equal(core.read.setupType, "NO_SCALP");
    assert.equal(core.read.flameStage, "NONE");
    assert.equal(core.read.scalpScore, 0);
  });

  it("agrees with blindFlameRead on every honesty-bearing field", () => {
    const core = readFlame(args());
    const sibling = blindFlameRead("AGGRESSIVE", { scannerReason: "Momentum breakout on the scanner" });
    for (const key of [
      "scalpStatus",
      "readDirection",
      "scalpScore",
      "flameStage",
      "flameAgeCandles",
      "entryTiming",
      "runway",
      "setupType",
      "htfContext",
      "blind",
    ] as const) {
      assert.equal(
        core.read[key],
        sibling[key],
        `blind reads diverge on "${key}": inline=${String(core.read[key])} sibling=${String(sibling[key])}`,
      );
    }
  });

  it("takes the blind branch for a too-short window, not just null", () => {
    const core = readFlame(args({ candles: [candle(0), candle(1), candle(2)] }));
    assert.equal(core.blind, true);
    assert.equal(core.read.entryTiming, "NO_ENTRY");
    assert.equal(core.read.runway, "NONE");
  });

  it("suggests no status downgrade (unchanged behaviour)", () => {
    const core = readFlame(args());
    assert.equal(core.downgrade.kind, null);
    assert.equal(core.scoreAdjust, 0);
  });
});

describe("A2 — a full evaluation of a blind read stays non-actionable", () => {
  for (const status of ["READY", "WAIT_FOR_ENTRY", "FORMING", "LATE"] as const) {
    it(`status ${status} with a high quality score cannot become actionable`, () => {
      const core = readFlame(args());
      const final = finalizeScalpVerdict(core.read, {
        status,
        qualityScore: 95,
        direction: "BUY",
        personality: "AGGRESSIVE",
      });
      assert.equal(final.entryTiming, "NO_ENTRY");
      assert.notEqual(final.scalpStatus, "STRONG");
      assert.notEqual(final.scalpStatus, "POSSIBLE");
      assert.equal(final.runway, "NONE");
    });
  }

  it("a non-actionable status also lands on NO_ENTRY", () => {
    const core = readFlame(args());
    const final = finalizeScalpVerdict(core.read, {
      status: "NO_SCALP",
      qualityScore: 0,
      direction: null,
      personality: "AGGRESSIVE",
    });
    assert.equal(final.entryTiming, "NO_ENTRY");
    assert.equal(final.scalpStatus, "NOT_A_SCALP");
    assert.equal(final.readDirection, "NO_SCALP");
  });
});

describe("A2 — the sighted path is untouched", () => {
  it("still produces a real read from a full candle window", () => {
    const candles = Array.from({ length: 12 }, (_, i) => candle(i));
    const core = readFlame(args({ candles }));
    assert.equal(core.blind, false);
    assert.notEqual(core.read.flameStage, "NONE");
  });
});
