import assert from "node:assert/strict";
import { test } from "node:test";
import { opportunityToEdgeInput, opportunityToProposal } from "../missionAgents.js";
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

test("Mission uses executable-side risk and the measured timing quality of this timeframe", () => {
  const row = { timeframe: "M1", dataSource: "LIVE_FEED", selectable: true, tradeable: true,
    recommendedAction: "BUY", entry: 100, bidAsk: { bid: 99.8, ask: 100.2 }, stopLoss: 99, takeProfit: 102,
    riskRewardRatio: 2, finalRead: { label: "TRADE_WATCH", analysisOnly: false },
    timingContext: { timeframe: "M1", dataQualityLabel: "partial", tradeabilityScore: 25 } } as ScannerOpportunity;
  for (const buy of [true, false]) {
    const opp: ScannerOpportunity = buy ? row : { ...row, recommendedAction: "SELL", stopLoss: 101, takeProfit: 98 };
    const p = opportunityToProposal("TREND", "levels", opp);
    assert.equal(p.entryPlan.entryPrice, buy ? 100.2 : 99.8);
    assert.ok(Math.abs(p.riskPlan.expectedR! - 1.5) < 1e-8);
    assert.equal(opportunityToEdgeInput(opp, p).components.timingQuality, 25);
    assert.equal(opportunityToEdgeInput({ ...opp, timingContext: { ...opp.timingContext!, timeframe: "H1" } }, p).components.timingQuality, null);
  }
});
