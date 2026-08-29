// Capability #42 — delayed risk increases: pure asymmetry proofs.
//
// Proven here (offline, no DB):
//   * every classified ceiling loosens/tightens in the documented direction
//     (including the two inverted numeric fields and the boolean protections),
//   * planRiskSettingsUpdate applies tightenings now and queues loosenings
//     behind the delay — never the other way round,
//   * the re-confirmation gate refuses before effectiveAt and refuses
//     non-PENDING rows.
//
// Run: pnpm --filter @workspace/api-server run test:risk-delayed-increase

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRiskSettingChange,
  planRiskSettingsUpdate,
  canConfirmPendingIncrease,
  RISK_CEILING_FIELDS,
  RISK_INCREASE_DELAY_MS,
} from "../delayedIncrease.js";

const NOW = new Date("2026-08-29T12:00:00Z");

test("numeric directions: higher-is-riskier fields", () => {
  for (const f of ["maxDailyLossPct", "maxWeeklyLossPct", "maxTradesPerDay", "maxOpenTrades", "maxLotSize", "riskPerTradePct", "stopAfterLosingStreak"]) {
    assert.equal(classifyRiskSettingChange(f, 2, 3), "LOOSEN", f);
    assert.equal(classifyRiskSettingChange(f, 3, 2), "TIGHTEN", f);
    assert.equal(classifyRiskSettingChange(f, 2, 2), "NEUTRAL", f);
  }
});

test("numeric directions: lower-is-riskier fields", () => {
  for (const f of ["cooldownAfterLossMinutes", "minConfidenceScore"]) {
    assert.equal(classifyRiskSettingChange(f, 30, 15), "LOOSEN", f);
    assert.equal(classifyRiskSettingChange(f, 15, 30), "TIGHTEN", f);
  }
});

test("boolean protections: flipping OFF a protection is a loosening", () => {
  for (const f of ["disableDuringAbnormalVolatility", "vol75ExtraConfidence", "vol75SmallLot", "us30BlockNews", "stocksBlockEarnings", "forexBlockEvents"]) {
    assert.equal(classifyRiskSettingChange(f, true, false), "LOOSEN", f);
    assert.equal(classifyRiskSettingChange(f, false, true), "TIGHTEN", f);
  }
});

test("unclassified fields are NEUTRAL (not this engine's business)", () => {
  assert.equal(classifyRiskSettingChange("riskMode", 0, 1), "NEUTRAL");
});

test("the classification map covers all 15 ceilings", () => {
  assert.equal(RISK_CEILING_FIELDS.length, 15);
});

test("plan: tightenings apply now, loosenings queue behind the delay", () => {
  const current = {
    maxDailyLossPct: 2, maxLotSize: 0.1, minConfidenceScore: 75,
    us30BlockNews: true, riskMode: "Balanced",
  };
  const requested = {
    maxDailyLossPct: 1,        // TIGHTEN → now
    maxLotSize: 0.2,           // LOOSEN → queue
    minConfidenceScore: 60,    // LOOSEN (lower bar) → queue
    us30BlockNews: false,      // LOOSEN (protection off) → queue
  };
  const plan = planRiskSettingsUpdate({ current, requested, now: NOW });
  assert.deepEqual(plan.applyNow, { maxDailyLossPct: 1 });
  assert.equal(plan.queue.length, 3);
  for (const q of plan.queue) {
    assert.equal(q.effectiveAt.getTime(), NOW.getTime() + RISK_INCREASE_DELAY_MS);
  }
  const boolQ = plan.queue.find((q) => q.field === "us30BlockNews")!;
  assert.equal(boolQ.valueKind, "boolean");
  assert.equal(boolQ.currentValue, 1);
  assert.equal(boolQ.targetValue, 0);
});

test("plan: unchanged values are dropped; unclassified fields pass through now", () => {
  const plan = planRiskSettingsUpdate({
    current: { maxLotSize: 0.1, cooldownAfterLossMinutes: 30 },
    requested: { maxLotSize: 0.1, cooldownAfterLossMinutes: 45, riskMode: undefined },
    now: NOW,
  });
  // Longer cooldown = tighter → applies now; identical lot size dropped.
  assert.deepEqual(plan.applyNow, { cooldownAfterLossMinutes: 45 });
  assert.equal(plan.queue.length, 0);
});

test("plan: an unreadable current value refuses to classify — honest no-op", () => {
  const plan = planRiskSettingsUpdate({
    current: {},
    requested: { maxLotSize: 5 },
    now: NOW,
  });
  assert.deepEqual(plan.applyNow, {});
  assert.equal(plan.queue.length, 0);
});

test("confirm gate: refused during the waiting period, allowed after", () => {
  const row = { status: "PENDING", effectiveAt: new Date(NOW.getTime() + 60_000) };
  const early = canConfirmPendingIncrease(row, NOW);
  assert.equal(early.ok, false);
  assert.equal((early as { reason: string }).reason, "WAITING_PERIOD_ACTIVE");
  assert.equal((early as { remainingMs?: number }).remainingMs, 60_000);
  const late = canConfirmPendingIncrease(row, new Date(NOW.getTime() + 60_000));
  assert.equal(late.ok, true);
});

test("confirm gate: non-PENDING rows always refused", () => {
  for (const status of ["APPLIED", "CANCELLED", "SUPERSEDED"]) {
    const v = canConfirmPendingIncrease({ status, effectiveAt: new Date(0) }, NOW);
    assert.equal(v.ok, false);
    assert.equal((v as { reason: string }).reason, "NOT_PENDING");
  }
});
