// Surgical-gap lock (Task #327, T006/T007): an AGGRESSIVE / OWNER_ADMIN personality
// (+1 tier shift) must NOT defeat baseAddOnTier()'s forced-zero on a dead/fading/
// extreme-chase/no-runway flame. The forced-zero is a PROTECTIVE invariant — adding
// to a basket on an exhausted/reversing burst is exactly the revenge-trade behavior
// the engine exists to prevent. Personality may only widen a tier that is ALREADY
// alive (base > 0); it can never resurrect a zero.
//
// Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpAddonForcedZero.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-addon-forced-zero`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAddOn } from "../scalpManage.js";
import type { ScalpFlameRead } from "../scalpTypes.js";
import type { BasketSummary } from "../scalpManage.js";

// A flat, in-profit basket so nothing in the losing/cushion branches masks the result.
const summary: BasketSummary = {
  entryCount: 1,
  totalVolume: 0.01,
  averageEntry: 1.1,
  currentPrice: 1.1005,
  combinedFloatingPl: 50,
  breakEvenPrice: 1.1,
  hasUnprotectedLeg: false,
};

// Base flame that, on its own, would justify adds — we degrade ONE dimension per case.
function flame(over: Partial<ScalpFlameRead>): ScalpFlameRead {
  return {
    symbol: "EURUSD",
    readDirection: "BUY",
    scalpStatus: "STRONG",
    flameStage: "RUN_HOT",
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "WIDE",
    scalpScore: 80,
    blind: false,
    ...over,
  } as ScalpFlameRead;
}

// Each case is a flame that baseAddOnTier() forces to tier 0. Personality must not lift it.
const FORCED_ZERO_CASES: Array<{ label: string; flame: ScalpFlameRead }> = [
  { label: "DEAD stage EXHAUSTED", flame: flame({ flameStage: "EXHAUSTED" }) },
  { label: "DEAD stage REVERSAL_RISK", flame: flame({ flameStage: "REVERSAL_RISK" }) },
  { label: "DEAD stage FAILED", flame: flame({ flameStage: "FAILED" }) },
  { label: "FADING stage WEAKENING", flame: flame({ flameStage: "WEAKENING" }) },
  { label: "chaseRisk EXTREME", flame: flame({ chaseRisk: "EXTREME" }) },
  { label: "runway NONE", flame: flame({ runway: "NONE" }) },
];

for (const personality of ["AGGRESSIVE", "OWNER_ADMIN"] as const) {
  for (const c of FORCED_ZERO_CASES) {
    test(`forced-zero holds for ${personality}: ${c.label}`, () => {
      const v = evaluateAddOn(c.flame, summary, personality);
      assert.equal(v.maxAddOns, 0, `${c.label}: personality must not lift forced-zero`);
      assert.equal(v.remainingAddOns, 0, `${c.label}: no remaining adds`);
      assert.equal(v.allowed, false, `${c.label}: adding must not be allowed`);
      assert.ok(
        v.recommendation === "DO_NOT_ADD" || v.recommendation === "HOLD",
        `${c.label}: recommendation must refuse the add (got ${v.recommendation})`,
      );
    });
  }
}

// Guard against over-correction: a live, healthy flame must STILL allow the
// AGGRESSIVE/OWNER widening (base > 0 → personality applies as before).
test("personality still widens a live, healthy flame (no over-correction)", () => {
  const balanced = evaluateAddOn(flame({}), summary, "BALANCED");
  const aggressive = evaluateAddOn(flame({}), summary, "AGGRESSIVE");
  assert.ok(balanced.maxAddOns > 0, "healthy flame allows adds at BALANCED");
  assert.ok(
    aggressive.maxAddOns >= balanced.maxAddOns,
    "AGGRESSIVE never narrows a live tier",
  );
});

// CONSERVATIVE (-1) must keep narrowing as before.
test("conservative still narrows a live flame", () => {
  const balanced = evaluateAddOn(flame({ scalpStatus: "POSSIBLE", flameStage: "RUN_ON" }), summary, "BALANCED");
  const conservative = evaluateAddOn(flame({ scalpStatus: "POSSIBLE", flameStage: "RUN_ON" }), summary, "CONSERVATIVE");
  assert.ok(conservative.maxAddOns <= balanced.maxAddOns, "CONSERVATIVE never widens");
});
