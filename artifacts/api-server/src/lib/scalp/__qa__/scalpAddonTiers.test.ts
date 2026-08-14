// Regression locks for the Ruby Flame Scalp add-on tier table and exit ladder.
// Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpAddonTiers.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-addon-tiers`)
//
// These complement scalpManage.test.ts. They lock the EXACT add-on tier
// produced per flame stage / scalp-status (tiers 0..3), the personality tier
// shift, the forced-zero dead/fading stages, the used-add cap, and the
// no-blind-add-on rule. All pure & deterministic — no DB, no network, no clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAddOn,
  evaluateExitUrgency,
  type BasketSummary,
} from "../scalpManage.js";
import type { ScalpFlameRead, FlameStage, RiskPersonality } from "../scalpTypes.js";

// A healthy, strong, fresh BUY flame with clean timing — the tier-3 baseline.
function flame(over: Partial<ScalpFlameRead> = {}): ScalpFlameRead {
  return {
    scalpStatus: "STRONG",
    readDirection: "BUY",
    scalpScore: 82,
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

// A basket summary in profit with `entryCount` legs (usedAddOns = entryCount-1).
function summary(over: Partial<BasketSummary> = {}): BasketSummary {
  return {
    entryCount: 1,
    totalVolume: 1,
    averageEntry: 100,
    currentPrice: 101,
    combinedFloatingPl: 25,
    breakEvenPrice: 100,
    hasUnprotectedLeg: false,
    ...over,
  };
}

// ── Tier table (0..3) by flame stage / scalp-status, BALANCED, fresh basket ──

const TIER_CASES: Array<{
  name: string;
  over: Partial<ScalpFlameRead>;
  expected: number;
}> = [
  { name: "STRONG + ACTIVE (healthy) => tier 3", over: { scalpStatus: "STRONG", flameStage: "ACTIVE" }, expected: 3 },
  { name: "STRONG + IGNITING (healthy) => tier 3", over: { scalpStatus: "STRONG", flameStage: "IGNITING" }, expected: 3 },
  { name: "STRONG + RUN_ON => tier 2", over: { scalpStatus: "STRONG", flameStage: "RUN_ON" }, expected: 2 },
  { name: "POSSIBLE + ACTIVE (healthy) => tier 2", over: { scalpStatus: "POSSIBLE", flameStage: "ACTIVE" }, expected: 2 },
  { name: "POSSIBLE + RUN_ON => tier 1", over: { scalpStatus: "POSSIBLE", flameStage: "RUN_ON" }, expected: 1 },
  { name: "WEAK + ACTIVE (live, non-fading) => tier 1", over: { scalpStatus: "WEAK", flameStage: "ACTIVE" }, expected: 1 },
];

for (const c of TIER_CASES) {
  test(`add-on tier: ${c.name}`, () => {
    const v = evaluateAddOn(flame(c.over), summary(), "BALANCED");
    assert.equal(v.maxAddOns, c.expected, `maxAddOns for ${c.name}`);
  });
}

// ── Forced-zero stages: dead, fading, extreme-chase, no-runway ──────────────

const FORCED_ZERO: Array<{ name: string; over: Partial<ScalpFlameRead> }> = [
  { name: "EXHAUSTED (dead)", over: { flameStage: "EXHAUSTED" } },
  { name: "FAILED (dead)", over: { flameStage: "FAILED" } },
  { name: "REVERSAL_RISK (dead)", over: { flameStage: "REVERSAL_RISK" } },
  { name: "WEAKENING (fading)", over: { flameStage: "WEAKENING" } },
  { name: "STRETCH (fading)", over: { flameStage: "STRETCH" } },
  { name: "chaseRisk EXTREME", over: { chaseRisk: "EXTREME" } },
  { name: "runway NONE", over: { runway: "NONE" } },
];

for (const c of FORCED_ZERO) {
  test(`add-on forced zero: ${c.name} => maxAddOns 0, never allowed (BALANCED)`, () => {
    const v = evaluateAddOn(flame(c.over), summary(), "BALANCED");
    assert.equal(v.maxAddOns, 0, `${c.name} must force tier 0`);
    assert.equal(v.allowed, false, `${c.name} must not be allowed`);
    assert.ok(
      v.recommendation === "DO_NOT_ADD" || v.recommendation === "HOLD",
      `${c.name} => DO_NOT_ADD/HOLD, got ${v.recommendation}`,
    );
  });
}

// ── Personality tier shift: ±1, clamped to [0,3] (live, addable flame) ───────

test("personality shift: CONSERVATIVE lowers tier 3 -> 2; AGGRESSIVE clamps at 3", () => {
  const conservative = evaluateAddOn(flame(), summary(), "CONSERVATIVE");
  assert.equal(conservative.maxAddOns, 2, "CONSERVATIVE -1 on a tier-3 base");
  const aggressive = evaluateAddOn(flame(), summary(), "AGGRESSIVE");
  assert.equal(aggressive.maxAddOns, 3, "AGGRESSIVE +1 clamps at ceiling 3");
  const owner = evaluateAddOn(flame(), summary(), "OWNER_ADMIN");
  assert.equal(owner.maxAddOns, 3, "OWNER_ADMIN +1 clamps at ceiling 3");
});

// NOTE: the all-personality forced-zero invariant (a dead/fading/extreme-chase/
// no-runway flame must stay tier 0 even under AGGRESSIVE/OWNER_ADMIN) is locked
// in scalpAddonForcedZero.test.ts — it exposed and now guards a real gap where
// the personality shift defeated the forced-zero guard. See docs/ALGORITHM_MAP.md.

// ── Used-add cap: remaining never negative, no stacking past the tier ────────

test("used-add cap: a fully scaled basket has remaining 0 and is not allowed", () => {
  // tier 3, 4 legs => usedAddOns 3 => remaining 0.
  const v = evaluateAddOn(flame(), summary({ entryCount: 4 }), "BALANCED");
  assert.equal(v.maxAddOns, 3);
  assert.equal(v.usedAddOns, 3);
  assert.equal(v.remainingAddOns, 0);
  assert.equal(v.allowed, false);
  assert.equal(v.recommendation, "HOLD");
});

test("used-add cap: over-scaled basket clamps remaining to 0 (never negative)", () => {
  const v = evaluateAddOn(flame(), summary({ entryCount: 6 }), "BALANCED");
  assert.equal(v.remainingAddOns, 0, "remaining is floored at 0");
  assert.ok(v.remainingAddOns >= 0);
});

test("no stacking into exhaustion: an open multi-leg basket on a dead flame must not add", () => {
  const v = evaluateAddOn(flame({ flameStage: "EXHAUSTED" }), summary({ entryCount: 2 }), "BALANCED");
  assert.equal(v.maxAddOns, 0);
  assert.equal(v.allowed, false);
  assert.equal(v.recommendation, "DO_NOT_ADD");
});

// ── Blind: no live flame => never an add-on, only HOLD ───────────────────────

test("blind flame: never adds, recommends HOLD, requires fresh confirmation", () => {
  const v = evaluateAddOn(flame({ blind: true, flameStage: "NONE" }), summary(), "AGGRESSIVE");
  assert.equal(v.maxAddOns, 0);
  assert.equal(v.allowed, false);
  assert.equal(v.recommendation, "HOLD");
  assert.equal(v.requiresFreshConfirmation, true);
});

// ── Exit ladder: dead/reversal rungs (complements scalpManage.test.ts) ──────

test("exit ladder: REVERSAL_RISK while losing => EMERGENCY / CLOSE_ALL, alert-only", () => {
  const v = evaluateExitUrgency(flame({ flameStage: "REVERSAL_RISK" }), summary({ combinedFloatingPl: -30 }));
  assert.equal(v.urgency, "EMERGENCY");
  assert.equal(v.action, "CLOSE_ALL");
  assert.equal(v.alertOnly, true);
});

test("exit ladder: EXHAUSTED (not losing) => CLOSE_ALL, alert-only", () => {
  const v = evaluateExitUrgency(flame({ flameStage: "EXHAUSTED" }), summary({ combinedFloatingPl: 12 }));
  assert.equal(v.urgency, "CLOSE_ALL");
  assert.equal(v.action, "CLOSE_ALL");
  assert.equal(v.alertOnly, true);
});

test("exit ladder is always alert-only across every reachable stage", () => {
  const stages: FlameStage[] = [
    "NONE", "IGNITING", "ACTIVE", "RUN_ON", "STRETCH",
    "WEAKENING", "EXHAUSTED", "FAILED", "REVERSAL_RISK",
  ];
  for (const s of stages) {
    for (const pl of [-30, 0, 30]) {
      const v = evaluateExitUrgency(flame({ flameStage: s }), summary({ combinedFloatingPl: pl, entryCount: 2 }));
      assert.equal(v.alertOnly, true, `${s} @ pl=${pl} must stay alert-only`);
    }
  }
});
