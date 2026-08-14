// Unit tests for the journal/personality pure module. Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpJournal.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-journal`)
//
// Pure-function tests — no DB, no network. They lock in the result/P-L-quality
// derivation, the honest after-action review copy, the synthetic detection, the
// rolling personality counts, and the bounded tightening-only bias.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  basketKeyFor,
  buildEntrySnapshot,
  computeQualityBias,
  deriveResult,
  deriveReview,
  applyPersonalityDelta,
  isSyntheticSymbol,
  flameIsContinuing,
  flameHasReversed,
  higherUrgency,
  EMPTY_PERSONALITY_COUNTS,
  PERSONALITY_MIN_SAMPLE,
  type PersonalityClosedTrade,
} from "../scalpJournal.js";
import type {
  ScalpBasket,
  ScalpFlameRead,
  ScalpAddOnVerdict,
  ScalpExitVerdict,
} from "../scalpTypes.js";

function flame(over: Partial<ScalpFlameRead> = {}): ScalpFlameRead {
  return {
    scalpStatus: "STRONG",
    readDirection: "BUY",
    scalpScore: 80,
    flameStage: "ACTIVE",
    flameAgeCandles: 2,
    freshness: "FRESH",
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "CLEAR",
    executionQuality: "GOOD",
    htfContext: "ALIGNED",
    setupType: "CONTINUATION",
    riskPersonality: "BALANCED",
    whyNow: "Fresh burst with room to run",
    entryTrigger: "Break and hold",
    targetIdea: "Next level up",
    invalidationIdea: "Loss of the low",
    decayNote: null,
    blind: false,
    ...over,
  };
}

function exitV(over: Partial<ScalpExitVerdict> = {}): ScalpExitVerdict {
  return { urgency: "NONE", action: "HOLD", headline: "Healthy", detail: "Let it work.", alertOnly: true, ...over };
}
function addOnV(over: Partial<ScalpAddOnVerdict> = {}): ScalpAddOnVerdict {
  return {
    recommendation: "HOLD",
    maxAddOns: 1,
    usedAddOns: 0,
    remainingAddOns: 1,
    allowed: false,
    revengeGuardTriggered: false,
    requiresFreshConfirmation: false,
    profitCushion: null,
    reason: "Hold.",
    ...over,
  };
}

function basket(over: Partial<ScalpBasket> = {}): ScalpBasket {
  return {
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    direction: "BUY",
    accountMode: "DEMO",
    entryCount: 1,
    totalVolume: 1,
    averageEntry: 1.1,
    currentPrice: 1.105,
    combinedFloatingPl: 12,
    breakEvenPrice: 1.1,
    hasUnprotectedLeg: false,
    legs: [
      {
        ticket: "1",
        volume: 1,
        entryPrice: 1.1,
        currentPrice: 1.105,
        floatingPl: 12,
        stopLoss: 1.09,
        takeProfit: 1.12,
        openedAt: "2026-06-03T00:00:00.000Z",
        isLatest: true,
      },
    ],
    flame: flame(),
    exit: exitV(),
    addOn: addOnV(),
    generatedAt: "2026-06-03T00:05:00.000Z",
    ...over,
  };
}

// ── synthetic detection ──────────────────────────────────────────────────────

test("synthetic detection: V75 / Boom / Crash are synthetic; EURUSD is not", () => {
  assert.equal(isSyntheticSymbol("Volatility 75 Index", null), true);
  assert.equal(isSyntheticSymbol("V75", null), true);
  assert.equal(isSyntheticSymbol("Boom 1000 Index", null), true);
  assert.equal(isSyntheticSymbol("Crash 500", null), true);
  assert.equal(isSyntheticSymbol("EURUSD", "forex"), false);
  assert.equal(isSyntheticSymbol("XAUUSD", "metals"), false);
  assert.equal(isSyntheticSymbol("ANYTHING", "Synthetic/Volatility"), true);
});

// ── basket key + snapshot ────────────────────────────────────────────────────

test("basketKey is stable per accountMode+symbol+direction+firstLeg", () => {
  const k = basketKeyFor("DEMO", "eurusd", "BUY", 1000);
  assert.equal(k, "DEMO|EURUSD|BUY|1000");
});

test("buildEntrySnapshot captures at-entry flame context", () => {
  const s = buildEntrySnapshot(basket(), {
    accountMode: "DEMO",
    timeframe: "M5",
    scalpMode: "SNIPER",
    spreadPoints: 8,
    executionLatencySeconds: 3,
  });
  assert.equal(s.symbol, "EURUSD");
  assert.equal(s.direction, "BUY");
  assert.equal(s.scoreAtEntry, 80);
  assert.equal(s.flameStageAtEntry, "ACTIVE");
  assert.equal(s.entryTimingAtEntry, "CLEAN");
  assert.equal(s.spreadPointsAtEntry, 8);
  assert.equal(s.executionLatencyAtEntry, 3);
  assert.equal(s.flameContinued, true);
  assert.equal(s.addOnCount, 0);
  assert.ok(s.basketKey.startsWith("DEMO|EURUSD|BUY|"));
});

test("buildEntrySnapshot stays honest when flame is blind", () => {
  const s = buildEntrySnapshot(basket({ flame: flame({ blind: true, flameStage: "NONE" }) }), {
    accountMode: "DEMO",
    timeframe: "M5",
  });
  assert.equal(s.setupType, null);
  assert.equal(s.flameContinued, false);
});

// ── flame continuation / reversal helpers ────────────────────────────────────

test("flameIsContinuing / flameHasReversed reflect stage", () => {
  assert.equal(flameIsContinuing(flame({ flameStage: "RUN_ON" })), true);
  assert.equal(flameIsContinuing(flame({ flameStage: "FAILED" })), false);
  assert.equal(flameHasReversed(flame({ flameStage: "FAILED" })), true);
  assert.equal(flameHasReversed(flame({ flameStage: "ACTIVE" })), false);
  assert.equal(flameIsContinuing(flame({ blind: true })), false);
});

test("higherUrgency picks the more urgent label", () => {
  assert.equal(higherUrgency("NONE", "CLOSE_ALL"), "CLOSE_ALL");
  assert.equal(higherUrgency("EMERGENCY", "WATCH"), "EMERGENCY");
});

// ── result + P/L quality ─────────────────────────────────────────────────────

test("deriveResult: realized P/L is KNOWN, floating is ESTIMATED, none is UNKNOWN", () => {
  assert.deepEqual(deriveResult({ realizedPl: 5, lastFloatingPl: 9 }), { result: "WIN", plQuality: "KNOWN", pl: 5 });
  assert.deepEqual(deriveResult({ realizedPl: null, lastFloatingPl: -4 }), { result: "LOSS", plQuality: "ESTIMATED", pl: -4 });
  assert.deepEqual(deriveResult({ realizedPl: null, lastFloatingPl: null }), { result: "UNKNOWN", plQuality: "UNKNOWN", pl: null });
  assert.equal(deriveResult({ realizedPl: 0, lastFloatingPl: null }).result, "BREAKEVEN");
});

// ── after-action review copy (honest, plain English) ─────────────────────────

test("review WIN with continuation: positive, warnedCorrectly null", () => {
  const r = deriveReview({
    result: "WIN", plQuality: "KNOWN", flameStageAtEntry: "ACTIVE", entryTimingAtEntry: "CLEAN",
    maxExitUrgency: "NONE", flameContinued: true, addOnCount: 0, isSynthetic: false,
  });
  assert.match(r.exitReason, /worked/i);
  assert.equal(r.warnedCorrectly, null);
});

test("review LOSS with no warning: warnedCorrectly false (missed it)", () => {
  const r = deriveReview({
    result: "LOSS", plQuality: "ESTIMATED", flameStageAtEntry: "ACTIVE", entryTimingAtEntry: "CLEAN",
    maxExitUrgency: "NONE", flameContinued: false, addOnCount: 0, isSynthetic: false,
  });
  assert.equal(r.warnedCorrectly, false);
  assert.match(r.exitReason, /fade|follow through|against/i);
});

test("review LOSS after a real exit warning: warnedCorrectly true", () => {
  const r = deriveReview({
    result: "LOSS", plQuality: "ESTIMATED", flameStageAtEntry: "STRETCH", entryTimingAtEntry: "LATE",
    maxExitUrgency: "CLOSE_ALL", flameContinued: true, addOnCount: 0, isSynthetic: false,
  });
  assert.equal(r.warnedCorrectly, true);
  assert.match(r.lesson, /warning|exit/i);
});

test("review WIN after close-all warning: warnedCorrectly false (cried wolf)", () => {
  const r = deriveReview({
    result: "WIN", plQuality: "KNOWN", flameStageAtEntry: "ACTIVE", entryTimingAtEntry: "CLEAN",
    maxExitUrgency: "EMERGENCY", flameContinued: true, addOnCount: 0, isSynthetic: false,
  });
  assert.equal(r.warnedCorrectly, false);
});

test("review UNKNOWN: incomplete result, no fabrication", () => {
  const r = deriveReview({
    result: "UNKNOWN", plQuality: "UNKNOWN", flameStageAtEntry: null, entryTimingAtEntry: null,
    maxExitUrgency: "NONE", flameContinued: false, addOnCount: 0, isSynthetic: false,
  });
  assert.match(r.exitReason, /incomplete|wasn't reported/i);
  assert.equal(r.warnedCorrectly, null);
});

test("review LOSS with add-ons calls out the adds", () => {
  const r = deriveReview({
    result: "LOSS", plQuality: "ESTIMATED", flameStageAtEntry: "ACTIVE", entryTimingAtEntry: "CLEAN",
    maxExitUrgency: "WATCH", flameContinued: true, addOnCount: 2, isSynthetic: false,
  });
  assert.match(r.lesson, /add/i);
});

test("review copy never uses guaranteed-return wording", () => {
  const banned = /guarantee|risk-?free|can'?t lose|sure thing|fixed %/i;
  for (const result of ["WIN", "LOSS", "BREAKEVEN", "UNKNOWN"] as const) {
    const r = deriveReview({
      result, plQuality: "KNOWN", flameStageAtEntry: "ACTIVE", entryTimingAtEntry: "CLEAN",
      maxExitUrgency: "NONE", flameContinued: true, addOnCount: 1, isSynthetic: true,
    });
    assert.ok(!banned.test(r.exitReason), `exitReason clean for ${result}`);
    assert.ok(!banned.test(r.lesson), `lesson clean for ${result}`);
  }
});

// ── personality rolling counts + bounded bias ────────────────────────────────

function closed(over: Partial<PersonalityClosedTrade> = {}): PersonalityClosedTrade {
  return {
    result: "LOSS",
    flameReversedAtClose: true,
    flameContinued: false,
    spreadPointsAtEntry: 10,
    flameAgeAtEntry: 3,
    scoreAtEntry: 70,
    isSynthetic: false,
    ...over,
  };
}

test("applyPersonalityDelta rolls counts and averages, ignoring null samples", () => {
  let p = EMPTY_PERSONALITY_COUNTS;
  p = applyPersonalityDelta(p, closed({ result: "WIN", flameContinued: true, flameReversedAtClose: false, spreadPointsAtEntry: 10 }));
  p = applyPersonalityDelta(p, closed({ result: "LOSS", spreadPointsAtEntry: null }));
  assert.equal(p.tradesClosed, 2);
  assert.equal(p.wins, 1);
  assert.equal(p.losses, 1);
  assert.equal(p.continuationCount, 1);
  assert.equal(p.reversalCount, 1);
  assert.equal(p.avgSpreadPoints, 10); // null second sample ignored
});

test("computeQualityBias is a no-op below the minimum sample", () => {
  let p = EMPTY_PERSONALITY_COUNTS;
  for (let i = 0; i < PERSONALITY_MIN_SAMPLE - 1; i++) p = applyPersonalityDelta(p, closed());
  const b = computeQualityBias(p);
  assert.equal(b.qualityBias, 0);
  assert.equal(b.minQualityDelta, 0);
  assert.equal(b.notes, null);
});

test("computeQualityBias only ever tightens (bias ≤ 0, delta ≥ 0) and is bounded", () => {
  let p = EMPTY_PERSONALITY_COUNTS;
  for (let i = 0; i < 8; i++) p = applyPersonalityDelta(p, closed()); // all losing reversals
  const b = computeQualityBias(p);
  assert.ok(b.qualityBias <= 0 && b.qualityBias >= -8, "bias clamped to [-8,0]");
  assert.ok(b.minQualityDelta >= 0 && b.minQualityDelta <= 10, "delta clamped to [0,10]");
  assert.ok(b.qualityBias < 0, "a losing/reversing symbol gets a penalty");
  assert.ok(b.notes && /stricter|cautious/i.test(b.notes));
});

test("a clean winning symbol earns no penalty", () => {
  let p = EMPTY_PERSONALITY_COUNTS;
  for (let i = 0; i < 6; i++) {
    p = applyPersonalityDelta(p, closed({ result: "WIN", flameContinued: true, flameReversedAtClose: false }));
  }
  const b = computeQualityBias(p);
  assert.equal(b.qualityBias, 0);
  assert.equal(b.minQualityDelta, 0);
});

test("synthetic reversal-prone symbol is penalised at least as hard as forex", () => {
  let synth = EMPTY_PERSONALITY_COUNTS;
  let fx = EMPTY_PERSONALITY_COUNTS;
  for (let i = 0; i < 6; i++) {
    synth = applyPersonalityDelta(synth, closed({ isSynthetic: true }));
    fx = applyPersonalityDelta(fx, closed({ isSynthetic: false }));
  }
  const bs = computeQualityBias(synth);
  const bf = computeQualityBias(fx);
  assert.ok(bs.qualityBias <= bf.qualityBias, "synthetic penalty >= forex");
});
