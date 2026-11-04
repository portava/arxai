// Trade plan checklist: a stop and target on the wrong side of entry are not
// a valid plan, so they cannot PASS reward-to-risk or "stop loss is defined".
//
// rewardToRisk used Math.abs for both distances and never read the plan's
// direction: a BUY with the stop ABOVE entry and the target BELOW it showed
// "Reward-to-risk is acceptable — R:R 2.00", "Stop loss is defined" PASS and
// "Ready — plan passes all blocking checks".
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChecklist, planRewardToRisk, type ChecklistInputs } from "../index.js";

function inputs(o: Partial<ChecklistInputs>): ChecklistInputs {
  return {
    symbol: "EURUSD", directionBias: "BUY", strategyId: null,
    marketCondition: "TRENDING", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    riskAmount: null, maxLossAllowed: null, rewardToRiskTarget: null, confidenceLevel: 70,
    permissionStatus: "CLEAR", permissionBlockers: [], permissionWarnings: [],
    brokerStatus: "CONNECTED", hasActiveRiskLock: false, ...o,
  };
}
const item = (r: ReturnType<typeof evaluateChecklist>, key: string) => r.items.find((i) => i.key === key)!;

test("BUY with the stop above and the target below entry is not ready", () => {
  const r = evaluateChecklist(inputs({ entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.08 }));
  assert.equal(item(r, "RR_OK").status, "FAIL");
  assert.equal(item(r, "SL_DEFINED").status, "FAIL");
  assert.equal(item(r, "TP_DEFINED").status, "FAIL");
  assert.match(item(r, "SL_DEFINED").detail, /above/i);
  assert.match(item(r, "RR_OK").detail, /wrong side/i);
  assert.equal(r.rewardToRisk, null, "no R:R is shown for an impossible plan");
  assert.equal(r.isReady, false);
});

test("SELL mirror: stop below / target above entry is not ready", () => {
  const r = evaluateChecklist(inputs({ directionBias: "SELL", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12 }));
  assert.equal(item(r, "RR_OK").status, "FAIL");
  assert.equal(item(r, "SL_DEFINED").status, "FAIL");
  assert.equal(r.isReady, false);
});

test("one wrong leg is enough to fail R:R; the good leg still passes", () => {
  const r = evaluateChecklist(inputs({ entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.095 }));
  assert.equal(item(r, "SL_DEFINED").status, "PASS");
  assert.equal(item(r, "TP_DEFINED").status, "FAIL");
  assert.equal(item(r, "RR_OK").status, "FAIL");
});

test("a correctly sided plan still passes with the same R:R", () => {
  const buy = evaluateChecklist(inputs({ entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12 }));
  assert.equal(item(buy, "RR_OK").status, "PASS");
  assert.ok(Math.abs((buy.rewardToRisk ?? 0) - 2) < 1e-9);
  const sell = evaluateChecklist(inputs({ directionBias: "SELL", entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.08 }));
  assert.equal(item(sell, "RR_OK").status, "PASS");
  assert.ok(Math.abs((sell.rewardToRisk ?? 0) - 2) < 1e-9);
});

test("no direction: stop and target on the same side of entry is invalid", () => {
  const r = evaluateChecklist(inputs({ directionBias: null, entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.12 }));
  assert.equal(item(r, "RR_OK").status, "FAIL");
  assert.equal(r.rewardToRisk, null);
});

test("planRewardToRisk is the one directional rule", () => {
  assert.equal(planRewardToRisk("BUY", 1.1, 1.11, 1.08).rr, null);
  assert.equal(planRewardToRisk("BUY", 1.1, 1.11, 1.08).stopSide, "WRONG");
  assert.ok(Math.abs((planRewardToRisk("SELL", 1.1, 1.11, 1.08).rr ?? 0) - 2) < 1e-9);
});

test("the plan review says the levels are on the wrong side, not that they are missing", async () => {
  const { summarizePlan } = await import("../index.js");
  const r = evaluateChecklist(inputs({ entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.08 }));
  const text = summarizePlan({
    symbol: "EURUSD", directionBias: "BUY", strategyId: null,
    rewardToRisk: r.rewardToRisk, rewardToRiskTarget: null, confidenceLevel: 70,
  }, r, "2026-10-28T12:00:00.000Z");
  assert.doesNotMatch(text, /entry, stop, and take-profit are required/);
  assert.match(text, /wrong side of entry/);
});

// A stop exactly at entry is a zero stop distance, not a same-side pair. With
// no BUY/SELL direction the checklist said "Stop loss and take profit are on
// the same side of entry" and "Stop loss 1.1 is at the 1.1 entry, on the same
// side as the take profit" — neither is true.
for (const directionBias of [null, "NEUTRAL"]) {
  test(`no direction (${directionBias}): a stop at entry is described as no stop distance, not same side`, async () => {
    const r = evaluateChecklist(inputs({ directionBias, entryPrice: 1.1, stopLoss: 1.1, takeProfit: 1.12 }));
    assert.equal(item(r, "RR_OK").status, "FAIL");
    assert.equal(item(r, "SL_DEFINED").status, "FAIL");
    assert.equal(item(r, "TP_DEFINED").status, "PASS");
    for (const key of ["RR_OK", "SL_DEFINED"]) {
      assert.doesNotMatch(item(r, key).detail, /same side/i, `${key}: ${item(r, key).detail}`);
      assert.match(item(r, key).detail, /no stop distance/i, `${key}: ${item(r, key).detail}`);
    }
    assert.match(item(r, "SL_DEFINED").detail, /1\.1 is at the 1\.1 entry/);
    const { summarizePlan } = await import("../index.js");
    const text = summarizePlan({
      symbol: "EURUSD", directionBias, strategyId: null,
      rewardToRisk: r.rewardToRisk, rewardToRiskTarget: null, confidenceLevel: null,
    }, r, "2026-10-28T12:00:00.000Z");
    assert.doesNotMatch(text, /wrong side/i, text);
    assert.match(text, /at the entry price/i, text);
  });
}

test("no direction: a take profit at entry is described as no target distance", () => {
  const r = evaluateChecklist(inputs({ directionBias: null, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.1 }));
  assert.equal(item(r, "TP_DEFINED").status, "FAIL");
  assert.equal(item(r, "SL_DEFINED").status, "PASS");
  for (const key of ["RR_OK", "TP_DEFINED"]) {
    assert.doesNotMatch(item(r, key).detail, /same side/i, `${key}: ${item(r, key).detail}`);
    assert.match(item(r, key).detail, /no target distance/i, `${key}: ${item(r, key).detail}`);
  }
});

test("no direction: a real same-side pair keeps the same-side wording", () => {
  const r = evaluateChecklist(inputs({ directionBias: null, entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.12 }));
  assert.match(item(r, "RR_OK").detail, /same side/i);
  assert.match(item(r, "SL_DEFINED").detail, /same side as the take profit/i);
});
