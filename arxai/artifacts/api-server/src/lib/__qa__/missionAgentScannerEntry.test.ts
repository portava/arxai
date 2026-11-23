import assert from "node:assert/strict";
import { test } from "node:test";
import { opportunityToEdgeInput, opportunityToProposal } from "../missionAgents.js";
import { measureScannerEntryRoom } from "../scannerEntryRoom.js";
import type { ChartLevel } from "../data/chart/engines/marketUnderstandingTypes.js";
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

test("Mission takes profit at the first defended level ahead of the entry", () => {
  for (const buy of [true,false]) {
    const side=buy ? "BUY" : "SELL";
    const quote={ bid:99, ask:101 };
    const stop=buy ? 98 : 102;
    const nominal=buy ? 107 : 93;
    const kind=buy ? "resistance" : "support";
    const defended=buy ? 105 : 95;
    const levels=[{kind,price:buy?104:96,personality:"invalidated"},{kind,price:defended,personality:"defended"},
      {kind,price:buy?98:102,personality:"defended"}] as ChartLevel[];
    const room=measureScannerEntryRoom(side, quote, stop, nominal, levels)!;
    assert.equal(room.target,defended);
    assert.equal(room.rewardToRisk,4/3);
    const opp={timeframe:"M1",dataSource:"LIVE_FEED",selectable:true,tradeable:true,
      recommendedAction:side,entry:100,bidAsk:quote,entryRoom:room,stopLoss:stop,takeProfit:nominal,
      finalRead:{label:"TRADE_WATCH",analysisOnly:false}} as ScannerOpportunity;
    const p=opportunityToProposal("TREND","p",opp);
    assert.equal(p.riskPlan.takeProfit,defended);
    assert.equal(p.riskPlan.expectedR,4/3);
    assert.equal(p.riskPlan.stopLoss,stop);
    assert.match(p.reason,/defended/);
    assert.equal(measureScannerEntryRoom(side, undefined, stop, nominal, levels),undefined);
    assert.equal(measureScannerEntryRoom(side, quote, stop, nominal, [])!.target,nominal);
  }
});

test("Scanner withholds room when the executable exit side has reached the stop", () => {
  const quote = { bid: 99, ask: 101 };
  for (const [side, stop, target] of [["BUY", 99, 109], ["SELL", 101, 91]] as const) {
    const room = measureScannerEntryRoom(side, quote, stop, target, []);
    assert.equal(room?.rewardToRisk, 0);
    const recovered = side === "BUY" ? { ...quote, bid: 99.1 } : { ...quote, ask: 100.9 };
    assert.equal(measureScannerEntryRoom(side, recovered, stop, target, [])?.rewardToRisk, 4);
  }
});

test("paper Mission ranks the spread against its own executable target in both directions", () => {
  for (const dir of ["BUY", "SELL"] as const) {
    const buy = dir === "BUY";
    const row = { timeframe: "M1", dataSource: "LIVE_FEED", recommendedAction: "WAIT" } as ScannerOpportunity;
    const proposal = opportunityToProposal("TREND", "spread", row);
    proposal.direction = dir;
    proposal.entryPlan.entryPrice = buy ? 102 : 100;
    proposal.marketSnapshot = { selectionModel: "mission_trend_continuation", bid: 100, ask: 102 };
    for (const [move, status] of [[20, "normal"], [12, "wide"], [8, "extreme"]] as const) {
      proposal.riskPlan.takeProfit = proposal.entryPlan.entryPrice + (buy ? move : -move);
      assert.equal(opportunityToEdgeInput(row, proposal).honesty.spread, status);
    }
    assert.equal(opportunityToEdgeInput({ ...row, timeframe: "H1" }, { ...proposal, timeframe: "H1" }).honesty.spread, "normal");
    proposal.entryPlan.entryPrice = 101;
    assert.equal(opportunityToEdgeInput(row, proposal).honesty.spread, "unknown");
  }
});
