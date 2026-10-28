// Trade plan checklist: the user's own inputs are not checks ARX ran.
//
// "Market condition supports setup" (detail "TRENDING"), "Strategy fit is
// acceptable — Confidence 80%" and "Risk amount is within limit — Risk 10 ≤
// max 20" were green PASS ticks, but each only echoed the dropdown / number
// the user typed: no market condition or strategy fit was observed, and risk
// was never computed from lot size × stop distance (lotSize is not an input).
// They are now UNKNOWN ("your input — not checked by ARX"); a self-reported
// value that fails the rule still FAILs, and readiness is unchanged.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChecklist, summarizePlan, type ChecklistInputs } from "../index.js";

function inputs(o: Partial<ChecklistInputs>): ChecklistInputs {
  return {
    symbol: "EURUSD", directionBias: "BUY", strategyId: null,
    marketCondition: "TRENDING", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    riskAmount: 10, maxLossAllowed: 20, rewardToRiskTarget: null, confidenceLevel: 80,
    permissionStatus: "CLEAR", permissionBlockers: [], permissionWarnings: [],
    brokerStatus: "CONNECTED", hasActiveRiskLock: false, ...o,
  };
}
const item = (r: ReturnType<typeof evaluateChecklist>, key: string) => r.items.find((i) => i.key === key)!;

test("typed market condition, confidence and risk are not PASS checks", () => {
  const r = evaluateChecklist(inputs({}));
  for (const key of ["MARKET_CONDITION", "STRATEGY_FIT", "RISK_AMOUNT"]) {
    const it = item(r, key);
    assert.notEqual(it.status, "PASS", `${key} echoes the user's input`);
    assert.equal(it.status, "UNKNOWN");
    assert.match(it.detail, /your input.*not checked by ARX/i, `${key}: ${it.detail}`);
  }
  assert.match(item(r, "RISK_AMOUNT").detail, /lot size/i);
  assert.match(item(r, "MARKET_CONDITION").detail, /TRENDING/);
  assert.match(item(r, "STRATEGY_FIT").detail, /80%/);
  assert.equal(r.passCount, 6, "only the checks ARX ran count as passes");
  assert.equal(r.isReady, true, "readiness is unchanged — these never blocked when satisfied");
});

test("a self-reported value that breaks the rule still fails", () => {
  assert.equal(item(evaluateChecklist(inputs({ marketCondition: "NO_TRADE" })), "MARKET_CONDITION").status, "FAIL");
  assert.equal(item(evaluateChecklist(inputs({ confidenceLevel: 40 })), "STRATEGY_FIT").status, "FAIL");
  assert.equal(item(evaluateChecklist(inputs({ riskAmount: 30 })), "RISK_AMOUNT").status, "FAIL");
});

test("the plan review does not say every check passed when some are the user's inputs", () => {
  const r = evaluateChecklist(inputs({}));
  const text = summarizePlan({
    symbol: "EURUSD", directionBias: "BUY", strategyId: null,
    rewardToRisk: r.rewardToRisk, rewardToRiskTarget: null, confidenceLevel: 80,
  }, r, "2026-10-28T12:00:00.000Z");
  assert.doesNotMatch(text, /All pre-trade checks pass/);
  assert.match(text, /not checked by ARX/i);
});
