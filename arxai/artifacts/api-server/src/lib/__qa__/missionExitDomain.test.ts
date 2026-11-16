// Profit Mission Phase 8 — Exit Manager Pro, Profit Locks & Compounding.
//
// Locks the pure, IO-free exit/protection engines and their honesty guarantees:
//  - decideExit protects justified early exits (invalidation/news/structure) and
//    only acts on observed prices (never fabricates an exit).
//  - buildPartialPlan degrades honestly when partials are unsupported.
//  - evaluateMilestones locks at 25/50/75/100%, stops+locks at target, fires the
//    giveback guard and the daily-goal lock.
//  - analyseMissedProfit rates capture WITHOUT punishing a risk-justified exit.
//  - evaluateCompounding activates from REALISED closed profit ONLY — never from
//    floating P/L, never during drawdown, never after a single win.
// Everything here is deterministic: identical inputs always produce identical
// output. No DB, no network, no clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideExit,
  buildPartialPlan,
  evaluateMilestones,
  analyseMissedProfit,
  evaluateCompounding,
  checkMissionCopyDeep,
} from "@workspace/domain/profit-mission";

// ── Exit Manager Pro (decideExit) ────────────────────────────────────────────

// Test 42 — exit on invalidation is logged as a justified early exit.
test("decideExit: invalidation → full CLOSE, justified early exit", () => {
  const d = decideExit({
    side: "BUY",
    entryPrice: 100,
    currentPrice: 101,
    takeProfit: 110,
    stopLoss: 98,
    invalidation: true,
  });
  assert.equal(d.action, "CLOSE");
  assert.equal(d.closeFraction, 1);
  assert.equal(d.trigger, "invalidation");
  assert.equal(d.justifiedEarlyExit, true);
});

// Test 40 — target hit → close to capture the planned target.
test("decideExit: target reached → CLOSE (capture planned target)", () => {
  const d = decideExit({
    side: "BUY",
    entryPrice: 100,
    currentPrice: 110,
    takeProfit: 110,
    stopLoss: 98,
  });
  assert.equal(d.action, "CLOSE");
  assert.equal(d.trigger, "target_hit");
  assert.equal(d.justifiedEarlyExit, false);
});

// Test 39 — protect profit after TP1: first a partial, then break-even.
test("decideExit: TP1 reached → PARTIAL_CLOSE, then break-even once taken", () => {
  const tp1 = decideExit({
    side: "BUY",
    entryPrice: 100,
    currentPrice: 106, // 60% of the 100→110 move
    takeProfit: 110,
    stopLoss: 98,
  });
  assert.equal(tp1.action, "PARTIAL_CLOSE");
  assert.equal(tp1.trigger, "tp1_reached");
  assert.ok(tp1.closeFraction != null && tp1.closeFraction > 0 && tp1.closeFraction < 1);

  const afterTp1 = decideExit({
    side: "BUY",
    entryPrice: 100,
    currentPrice: 106,
    takeProfit: 110,
    stopLoss: 98,
    partialTaken: 0.33,
  });
  assert.equal(afterTp1.action, "MOVE_BREAKEVEN");
  assert.equal(afterTp1.newPrice, 100);
  assert.equal(afterTp1.trigger, "breakeven_secure");
});

test("decideExit: missing prices → NONE (never fabricates an exit)", () => {
  const d = decideExit({ side: "BUY", entryPrice: null, currentPrice: null });
  assert.equal(d.action, "NONE");
  assert.equal(d.closeFraction, null);
  assert.equal(d.newPrice, null);
});

// ── PartialProfitPlan ────────────────────────────────────────────────────────

test("buildPartialPlan: supported broker → ordered TP1/breakeven/runner steps", () => {
  const plan = buildPartialPlan({
    side: "BUY",
    entryPrice: 100,
    takeProfit: 110,
    stopLoss: 98,
    brokerSupportsPartialClose: true,
  });
  assert.equal(plan.degraded, false);
  assert.ok(plan.steps.length >= 2);
  // steps are ordered
  for (let i = 1; i < plan.steps.length; i++) {
    assert.ok(plan.steps[i].order >= plan.steps[i - 1].order);
  }
  assert.ok(plan.steps.some((s) => s.kind === "PARTIAL_CLOSE"));
});

test("buildPartialPlan: unsupported broker → honest degrade to full close", () => {
  const plan = buildPartialPlan({
    side: "BUY",
    entryPrice: 100,
    takeProfit: 110,
    stopLoss: 98,
    brokerSupportsPartialClose: false,
  });
  assert.equal(plan.degraded, true);
  // never silently pretends a partial happened
  assert.ok(!plan.steps.some((s) => s.kind === "PARTIAL_CLOSE"));
});

// ── ProfitMilestones + protection ladder + giveback + daily-goal ─────────────

// Test 24 — locks profit / tightens setup tier at milestones.
test("evaluateMilestones: 50% milestone locks profit and tightens tier", () => {
  const v = evaluateMilestones({ requiredProfit: 1000, realisedProfit: 500 });
  assert.equal(v.milestone, 50);
  assert.equal(v.lockedProfit, 500);
  assert.equal(v.minSetupTier, "A");
  assert.ok(v.riskMultiplier <= 1);
});

// Test 25 — target reached → stop + lock by default.
test("evaluateMilestones: 100% target default = stop + lock", () => {
  const v = evaluateMilestones({ requiredProfit: 1000, realisedProfit: 1000 });
  assert.equal(v.milestone, 100);
  assert.equal(v.stopAndLock, true);
  assert.equal(v.suggestedMode, "stop");
});

// Test 25 (cont.) — continuing past target must AUTO-REDUCE risk (never looser).
test("evaluateMilestones: continue past target → reduced risk, A+ only, no stop", () => {
  const v = evaluateMilestones({
    requiredProfit: 1000,
    realisedProfit: 1000,
    continueAfterTarget: true,
  });
  assert.equal(v.stopAndLock, false);
  assert.equal(v.minSetupTier, "A_PLUS");
  assert.ok(v.riskMultiplier <= 0.25);
});

// Test 56 — gave back ≥ threshold of peak → protect mode + reduced risk.
test("evaluateMilestones: giveback from peak → protect + risk cut", () => {
  const v = evaluateMilestones({
    requiredProfit: 1000,
    realisedProfit: 300,
    peakRealisedProfit: 600, // gave back 50% of peak
  });
  assert.equal(v.givebackTriggered, true);
  assert.equal(v.suggestedMode, "protect");
  assert.ok(v.riskMultiplier <= 0.5);
});

// Test 26 — daily profit goal reached → lock/protect for the day.
test("evaluateMilestones: daily goal reached → daily-goal lock", () => {
  const v = evaluateMilestones({
    requiredProfit: 1000,
    realisedProfit: 200,
    dailyProfitGoal: 100,
    realisedProfitToday: 120,
  });
  assert.equal(v.dailyGoalReached, true);
  assert.ok(v.riskMultiplier <= 0.5);
});

// ── MissedProfit analysis ────────────────────────────────────────────────────

// Test 41 — records the capture rate from MFE vs captured profit.
test("analyseMissedProfit: computes capture rate and missed amount", () => {
  const v = analyseMissedProfit({ realisedPnl: 60, mfeProfit: 100 });
  assert.equal(v.capturedProfit, 60);
  assert.equal(v.availableProfit, 100);
  assert.equal(v.captureRate, 0.6);
  assert.equal(v.missedProfit, 40);
  assert.equal(v.quality, "good_capture");
});

test("analyseMissedProfit: protective early exit is justified, never penalised", () => {
  const v = analyseMissedProfit({ realisedPnl: 20, mfeProfit: 100, protectiveExit: true });
  assert.equal(v.justified, true);
  assert.equal(v.quality, "justified_early_exit");
});

// ── ControlledCompounding ────────────────────────────────────────────────────

// Test 23 — compounds from REALISED closed profit only (multiple closed wins).
test("evaluateCompounding: realised profit + enough trades → active, multiplier > 1", () => {
  const v = evaluateCompounding({
    mode: "balanced",
    userAllowed: true,
    realisedProfit: 500,
    realisedTradeCount: 4,
    drawdownPct: 0,
    governorMode: "normal",
    baseCapital: 1000,
  });
  assert.equal(v.active, true);
  assert.ok(v.multiplier > 1);
  assert.ok(v.reinvestibleProfit > 0);
});

test("evaluateCompounding: floating-only profit (no realised) → inactive, multiplier 1", () => {
  const v = evaluateCompounding({
    mode: "balanced",
    userAllowed: true,
    realisedProfit: 0,
    realisedTradeCount: 4,
    drawdownPct: 0,
    governorMode: "normal",
  });
  assert.equal(v.active, false);
  assert.equal(v.multiplier, 1);
});

// compounding-not-in-drawdown — ANY drawdown blocks compounding entirely.
test("evaluateCompounding: ANY drawdown → inactive, multiplier 1", () => {
  const v = evaluateCompounding({
    mode: "aggressive",
    userAllowed: true,
    realisedProfit: 500,
    realisedTradeCount: 5,
    drawdownPct: 2,
    governorMode: "normal",
    baseCapital: 1000,
  });
  assert.equal(v.active, false);
  assert.equal(v.multiplier, 1);
  assert.ok(v.blockers.some((b) => /drawdown/i.test(b)));
});

test("evaluateCompounding: single win → inactive (needs ≥3 realised trades)", () => {
  const v = evaluateCompounding({
    mode: "balanced",
    userAllowed: true,
    realisedProfit: 500,
    realisedTradeCount: 1,
    drawdownPct: 0,
    governorMode: "normal",
    baseCapital: 1000,
  });
  assert.equal(v.active, false);
  assert.equal(v.multiplier, 1);
});

// ── Banned guaranteed-profit vocabulary over engine-generated copy ────────────

test("engine-generated copy never uses banned guaranteed-profit vocabulary", () => {
  const copyBundles: string[][] = [];

  copyBundles.push(
    decideExit({
      side: "BUY",
      entryPrice: 100,
      currentPrice: 106,
      takeProfit: 110,
      stopLoss: 98,
    }).reasons,
  );
  copyBundles.push(
    buildPartialPlan({
      side: "BUY",
      entryPrice: 100,
      takeProfit: 110,
      stopLoss: 98,
      brokerSupportsPartialClose: true,
    }).steps.map((s) => s.label),
  );
  copyBundles.push(
    evaluateMilestones({ requiredProfit: 1000, realisedProfit: 1000 }).reasons,
  );
  copyBundles.push(analyseMissedProfit({ realisedPnl: 60, mfeProfit: 100 }).reasons);
  copyBundles.push(
    evaluateCompounding({
      mode: "balanced",
      userAllowed: true,
      realisedProfit: 500,
      realisedTradeCount: 4,
      drawdownPct: 0,
      governorMode: "normal",
      baseCapital: 1000,
    }).reasons,
  );

  for (const bundle of copyBundles) {
    const verdict = checkMissionCopyDeep(bundle);
    assert.equal(
      verdict.ok,
      true,
      `banned vocabulary found: ${JSON.stringify(verdict)}`,
    );
  }
});
