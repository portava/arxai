// Opportunity Map: a row whose own final read says "No trade right now." or
// "Wait for confirmation." must never be filed under "Ready now".
//
// categoryOf looked only at live data, lateness, high/critical news, the raw
// recommendedAction, edge >= 55 and entry >= 50. It never read finalRead.label,
// so every downgrade computeFinalRead applies (risk rejection, low technical
// confidence, medium news, conflicts, non-live data, sufficiency) was ignored:
// a BUY rejected by risk landed in READY_NOW with the verdict "Ready now",
// bestAction "Entry is open — consider a buy", the row reason "No trade right
// now." and eligibility for Best scalp / Best retest and the "cleaner
// opportunity" banner.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categorizeOpportunities,
  compareBestVsSelected,
} from "@workspace/domain/signal-intelligence";
import { toInput } from "../opportunityMapService.js";
import { driftPullbackTrigger, computeFinalRead, type ScannerOpportunity } from "../../marketScanner.js";

function mkOpp(overrides: Partial<ScannerOpportunity>): ScannerOpportunity {
  const base = {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "retest",
    confidenceScore: 70,
    riskScore: 40,
    entrySniperScore: 75,
    riskRewardRatio: 2,
    reasonForTrade: "test",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "READY",
    opportunity: { score: 57 },
    entry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    generatedAt: new Date().toISOString(),
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
  };
  return { ...base, ...overrides } as unknown as ScannerOpportunity;
}

function mapFor(opp: ScannerOpportunity) {
  const withFinal = { ...opp, finalRead: computeFinalRead(opp) } as ScannerOpportunity;
  const input = toInput(withFinal, { isLate: false } as Parameters<typeof toInput>[1]);
  return { finalRead: withFinal.finalRead!, result: categorizeOpportunities([input]) };
}

const DOWNGRADED: Array<{ name: string; opp: Partial<ScannerOpportunity> }> = [
  { name: "rejected by risk (final NO_TRADE)", opp: { statusBadge: "REJECTED_BY_RISK" } },
  { name: "choppy market (final NO_TRADE)", opp: { statusBadge: "CHOPPY_MARKET" } },
  { name: "low technical confidence (final WAIT)", opp: { statusBadge: "LOW_CONFIDENCE" } },
  { name: "setup wants confirmation (final WAIT)", opp: { statusBadge: "WAIT_FOR_CONFIRMATION" } },
  { name: "chart not confirmed (final WAIT)", opp: { chartConfirmed: false } },
  {
    name: "regime UNKNOWN (final WAIT)",
    opp: { regime: { regime: "UNKNOWN" } as unknown as ScannerOpportunity["regime"] },
  },
  {
    name: "failed chart pattern (final AVOID_FOR_NOW)",
    opp: { patternImpact: { labelHint: "failed_setup" } as unknown as ScannerOpportunity["patternImpact"] },
  },
  {
    name: "trendline trap (final AVOID_FOR_NOW)",
    opp: { trendlineImpact: { labelHint: "trap_risk" } as unknown as ScannerOpportunity["trendlineImpact"] },
  },
  {
    name: "medium news (final WAIT)",
    opp: { newsContext: { riskLevel: "medium", alignsWithScanner: null } as unknown as ScannerOpportunity["newsContext"] },
  },
];

for (const c of DOWNGRADED) {
  test(`${c.name}: never READY_NOW, never a best pick, never the cleaner alternative`, () => {
    const { finalRead, result } = mapFor(mkOpp(c.opp));
    assert.notEqual(finalRead.label, "TRADE_WATCH", "fixture must be a downgraded final read");
    const row = result.rows[0]!;
    assert.notEqual(row.category, "READY_NOW", `${c.name}: final=${finalRead.label} reason="${row.reason}"`);
    assert.notEqual(row.stageLabel, "Ready now");
    assert.doesNotMatch(row.bestAction, /Entry is open/);
    if (finalRead.label === "NO_TRADE" || finalRead.label === "AVOID_FOR_NOW") {
      assert.equal(row.category, "AVOID");
      assert.equal(result.best.bestScalp, null);
      assert.equal(result.best.bestRetest, null);
      const banner = compareBestVsSelected(result, "GBPUSD");
      assert.equal(banner.hasCleanerAlternative, false);
      assert.equal(banner.best, null);
    }
    assert.equal(result.categories.READY_NOW.length, 0);
  });
}

test("a clean TRADE_WATCH live row is still Ready now", () => {
  const { finalRead, result } = mapFor(mkOpp({}));
  assert.equal(finalRead.label, "TRADE_WATCH");
  assert.equal(result.rows[0]!.category, "READY_NOW");
});

test("domain: a row with an unknown final read (null) is not Ready now", () => {
  const base = toInput({ ...mkOpp({}), finalRead: computeFinalRead(mkOpp({})) } as ScannerOpportunity,
    { isLate: false } as Parameters<typeof toInput>[1]);
  const result = categorizeOpportunities([{ ...base, finalReadLabel: null }]);
  assert.notEqual(result.rows[0]!.category, "READY_NOW");
});

test("a drift watch needs an aligned entry trigger and a spent pullback cannot fire twice", () => {
  const pullback = { open: 102, high: 103, low: 99, close: 100 };
  const reclaim = { open: 100, high: 105, low: 100, close: 104 };
  const row = mkOpp({ setupType: "Upward drift", regime: { regime: "TREND_UP", substate: null,
    confidence01: .8, consecutiveConfirmations: 4, reasons: [] } });
  const read = (bars: typeof reclaim[]) => computeFinalRead({ ...row, driftTrigger: driftPullbackTrigger(bars, "BUY") });
  assert.equal(read([pullback]).label, "WAIT_FOR_CONFIRMATION");
  assert.match(read([pullback]).headline, /above the pullback high at 103/);
  assert.equal(read([pullback, reclaim]).label, "WAIT_FOR_CONFIRMATION");
  assert.match(read([pullback, reclaim]).headline, /touch 103 and close above/);
  assert.equal(read([pullback, reclaim, { ...reclaim, close: 105 }]).label, "TRADE_WATCH");
  assert.equal(read([pullback, reclaim, { open: 104, low: 103.5, high: 106, close: 105 }]).label, "WAIT_FOR_CONFIRMATION");
  assert.equal(computeFinalRead({ ...row, regime: { ...row.regime!, regime: "RANGE" },
    driftTrigger: driftPullbackTrigger([pullback, reclaim], "BUY") }).label, "WAIT_FOR_CONFIRMATION");
  const redAbove = { open: 108, high: 109, low: 104, close: 105 };
  assert.equal(read([pullback, redAbove]).label, "WAIT_FOR_CONFIRMATION");
  const greenBelow = { open: 96, high: 99, low: 95, close: 98 };
  assert.deepEqual(driftPullbackTrigger([reclaim, greenBelow], "SELL"),
    { side: "SELL", level: 100, confirmed: true });
  assert.deepEqual(driftPullbackTrigger([reclaim, { ...pullback, close: 99 }], "SELL"),
    { side: "SELL", level: 100, confirmed: true });
});

test("an aligned confirmed pattern can use one retest bar while an unrelated line forms", () => {
  const bars = [
    { open: 102, high: 103, low: 99, close: 100 },
    { open: 100, high: 106, low: 100, close: 105 },
    { open: 105, high: 108, low: 103, close: 107 },
  ];
  const row = mkOpp({ setupType: "Upward drift", regime: { regime: "TREND_UP", substate: null,
    confidence01: .8, consecutiveConfirmations: 4, reasons: [] }, driftTrigger: driftPullbackTrigger(bars, "BUY"),
    patternTrigger: { name: "Break and retest", bias: "bullish", confirmed: true, invalidation: 99 },
    patternImpact: { labelHint: "needs_confirmation", conditional: true, qualityCeiling: "medium",
      contextOnly: false, confidenceCeiling: 80, supportive: false, edgeAdjustment: 0 },
    trendlineImpact: { labelHint: "forming_line", conditional: true, qualityCeiling: "medium",
      contextOnly: false, confidenceCeiling: 60, supportive: false, edgeAdjustment: -5 } });
  assert.equal(row.driftTrigger?.followThroughLevel, 103);
  assert.equal(computeFinalRead(row).label, "TRADE_WATCH");
  assert.equal(computeFinalRead({ ...row, chartConfirmed: false }).label, "WAIT_FOR_CONFIRMATION");
  assert.equal(computeFinalRead({ ...row, patternTrigger: { ...row.patternTrigger!, confirmed: false } }).label, "WAIT_FOR_CONFIRMATION");
  assert.equal(computeFinalRead({ ...row, trendlineImpact: { ...row.trendlineImpact!, labelHint: "trap_risk" } }).label, "AVOID_FOR_NOW");
  assert.equal(driftPullbackTrigger([...bars, bars[2]!], "BUY")?.followThroughLevel, undefined);
});

test("a held retest in a range names the regime as the outstanding condition", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const row = mkOpp({ recommendedAction: side, setupType: side === "BUY" ? "Upward drift" : "Downward drift",
      regime: { regime: "RANGE", substate: null, confidence01: .8, consecutiveConfirmations: 2, reasons: [] },
      driftTrigger: { side, confirmed: false, level: null, retestLevel: 100, previousBreakLevel: 100 } });
    const read = computeFinalRead(row);
    assert.equal(read.label, "WAIT_FOR_CONFIRMATION");
    assert.match(read.headline, /retest at 100 held/i);
    assert.match(read.headline, side === "BUY" ? /rising trend/ : /falling trend/);
    assert.doesNotMatch(read.reasons.join(" "), /did not hold/);
  }
});

test("a closed pullback loses its entry when the current exit-side quote crosses back", () => {
  for (const buy of [true, false]) {
    const side = buy ? "BUY" : "SELL";
    const row = mkOpp({ recommendedAction: side, setupType: buy ? "Upward drift" : "Downward drift",
      regime: { regime: buy ? "TREND_UP" : "TREND_DOWN", substate: null,
        confidence01: .8, consecutiveConfirmations: 4, reasons: [] },
      driftTrigger: { side, level: 100, confirmed: false, retestLevel: 100 } });
    const lost = computeFinalRead({ ...row, bidAsk: { bid: 99.99, ask: 100.01 } });
    assert.equal(lost.label, "WAIT_FOR_CONFIRMATION");
    assert.match(lost.headline, /no longer holds it/);
    assert.equal(computeFinalRead({ ...row, bidAsk: buy ? { bid: 101, ask: 102 } : { bid: 98, ask: 99 } }).label, "TRADE_WATCH");
  }
});

test("a confirmed Scanner entry with less than one risk unit of room quotes the pullback price", () => {
  const row=mkOpp({recommendedAction:"BUY", chartConfirmed:true, stopLoss:97, takeProfit:106,
    entryRoom:{entry:101,target:103,defendedLevel:103,rewardToRisk:.5,oneRiskEntry:100}});
  const r=computeFinalRead(row);
  assert.equal(r.label,"WAIT_FOR_CONFIRMATION");
  assert.match(r.headline,/0.50R.*resistance at 103.*ask at or below 100/);
  assert.equal(computeFinalRead({...row,entryRoom:{...row.entryRoom!,rewardToRisk:1}}).label,"TRADE_WATCH");
  assert.notEqual(computeFinalRead({...row,chartConfirmed:false}).label,"TRADE_WATCH");
});
