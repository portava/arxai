import assert from "node:assert/strict";
import { test } from "node:test";
import { opportunityToProposal } from "../missionAgents.js";
import type { ScannerOpportunity } from "../marketScanner.js";

test("Profit Mission only publishes entry levels for a live, reviewed directional setup", () => {
  const raw = { symbol: "V75", timeframe: "M1", dataSource: "LIVE_FEED", selectable: true, tradeable: true,
    recommendedAction: "SELL", confidenceScore: 80, riskRewardRatio: 2, entry: 100, stopLoss: 101,
    takeProfit: 98, reasonForTrade: "Downward drift" } as ScannerOpportunity;
  const wait = { headline: "Watch for a close below 98.", label: "WAIT_FOR_CONFIRMATION",
    reasons: [], confidence: "MEDIUM", technicalScore: 80, historicalScore: null, newsRiskLevel: "none",
    analysisOnly: false, conflict: false } as const;
  for (const label of ["WAIT_FOR_CONFIRMATION", "AVOID_FOR_NOW", "NO_TRADE"] as const) {
    const p = opportunityToProposal("TREND", "observation", { ...raw, finalRead: { ...wait, reasons: [], label } });
    assert.equal(p.direction, "NONE");
    assert.equal(p.entryPlan.entryPrice, null);
    assert.equal(p.riskPlan.expectedR, null);
    assert.equal(p.reason, wait.headline);
  }
  assert.equal(opportunityToProposal("TREND", "missing", raw).direction, "NONE");
  const ready = opportunityToProposal("TREND", "ready", { ...raw, finalRead: { ...wait, label: "TRADE_WATCH", reasons: [] } });
  assert.equal(ready.direction, "SELL");
  assert.deepEqual([ready.entryPlan.entryPrice, ready.riskPlan.stopLoss, ready.riskPlan.takeProfit], [100, 101, 98]);
});
