// Execution Cost & Survivability (Task #196) — PURE estimator unit tests.
//
// Verifies the honesty + math contracts of estimateExecutionPreview:
//  1. Spread cost = spreadPoints × moneyPerPoint (lot-scaled).
//  2. Slippage scales with lot size (a 1.0-lot order slips more than 0.01).
//  3. Break-even (in points) == spread + expected slippage == starting drawdown.
//  4. After-cost loss > gross loss and after-cost R:R < gross R:R.
//  5. Missing broker spec → honest degrade (pointInferred, degraded notes),
//     never fabricated broker truth.
//  6. A tight stop versus volatility → low survivability + a plain-English
//     warning (no internal token).
//  7. Broker-condition BLOCK when the symbol is not tradable; reasons become
//     blockers.
//  8. No internal UPPER_SNAKE enum tokens leak into ANY user-facing string.
//
// No DB, no IO — estimateExecutionPreview is pure & deterministic.
//
// Run: pnpm --filter @workspace/scripts run test:execution-preview

import {
  estimateExecutionPreview,
  type ExecutionPreviewInput,
} from "@workspace/domain/execution-preview";

type BrokerSpec = ExecutionPreviewInput["spec"];

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}
function approx(a: number, b: number, tol = 0.02): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

// Broker truth for a EURUSD-class symbol (5-digit, point = 0.00001).
const fxSpec: BrokerSpec = {
  visible: true,
  tradeAllowed: true,
  tradeMode: "FULL",
  marketOpen: true,
  point: 0.00001,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  stopsLevelPoints: 0,
  freezeLevelPoints: 0,
};

function baseInput(overrides: Partial<ExecutionPreviewInput> = {}): ExecutionPreviewInput {
  return {
    symbol: "EURUSD",
    side: "BUY",
    orderType: "MARKET",
    entry: null,
    stopLoss: null,
    takeProfit: null,
    lots: 0.1,
    spec: fxSpec,
    hasBrokerTruth: true,
    quote: { bid: 1.10000, ask: 1.10010, quoteAgeMs: 500 },
    atrPrice: 0.0020,
    slippageHistory: null,
    accountBalance: 10_000,
    leverage: 100,
    riskPercent: 1,
    openExposure: null,
    maxSpreadPoints: 300,
    ...overrides,
  };
}

// ── 1. Spread cost = spreadPoints × moneyPerPoint ─────────────────────────────
{
  const p = estimateExecutionPreview(baseInput({ lots: 0.1 }));
  // ask-bid = 0.00010, point = 0.00001 → 10 points spread.
  check("spread points = (ask-bid)/point", approx(p.spreadCost.points, 10));
  check("moneyPerPoint is positive (forex contract model)", (p.moneyPerPoint ?? 0) > 0);
  const expected = p.spreadCost.points * (p.moneyPerPoint ?? 0);
  check("spread cost money = points × moneyPerPoint", approx(p.spreadCost.money ?? -1, expected));
}

// ── 2. Slippage scales with lot size ──────────────────────────────────────────
{
  const small = estimateExecutionPreview(baseInput({ lots: 0.01 }));
  const big = estimateExecutionPreview(baseInput({ lots: 2.0 }));
  check("bigger lot → higher expected slippage money",
    (big.slippage.expectedMoney ?? 0) > (small.slippage.expectedMoney ?? 0));
  check("bigger lot → higher expected slippage points",
    big.slippage.expectedPoints > small.slippage.expectedPoints);
}

// ── 3. Break-even == spread + expected slip == starting drawdown ───────────────
{
  const p = estimateExecutionPreview(baseInput());
  const sum = p.spreadCost.points + p.slippage.expectedPoints;
  check("break-even points == spread + expected slippage", approx(p.breakEven.points, sum));
  check("starting drawdown == break-even (pain before profit)",
    approx(p.startingDrawdown.points, p.breakEven.points));
}

// ── 4. After-cost loss > gross; after-cost R:R < gross R:R ─────────────────────
{
  // entry 1.10010 (ask), SL 50 pips below, TP 100 pips above → gross R:R 2.0
  const p = estimateExecutionPreview(baseInput({
    entry: 1.10010, stopLoss: 1.09510, takeProfit: 1.11010,
  }));
  check("after-cost SL money present", p.afterCost.stopLossMoney != null);
  check("after-cost TP money present", p.afterCost.takeProfitMoney != null);
  check("gross R:R ~ 2.0", approx(p.afterCost.grossRiskRewardRatio ?? 0, 2.0, 0.05));
  check("after-cost R:R < gross R:R (cost erodes reward)",
    (p.afterCost.riskRewardRatio ?? 99) < (p.afterCost.grossRiskRewardRatio ?? 0));
}

// ── 5. Missing broker spec → honest degrade, never fabricated truth ───────────
{
  const noSpec: BrokerSpec = {
    visible: null, tradeAllowed: null, tradeMode: null, marketOpen: null,
    point: null, minVolume: null, maxVolume: null, volumeStep: null,
    stopsLevelPoints: null, freezeLevelPoints: null,
  };
  const p = estimateExecutionPreview(baseInput({ spec: noSpec, hasBrokerTruth: false }));
  check("missing broker point → pointInferred true", p.pointInferred === true);
  check("missing broker truth → dataQuality.degraded true", p.dataQuality.degraded === true);
  check("missing broker truth → hasBrokerTruth false", p.dataQuality.hasBrokerTruth === false);
  check("degrade carries an explanatory note", p.dataQuality.notes.length > 0);
}

// ── 6. Tight stop vs volatility → low survivability + warning ─────────────────
{
  // ATR 0.0020; stop only 0.0004 away (0.2 ATR) → inside normal noise.
  const tight = estimateExecutionPreview(baseInput({
    entry: 1.10010, stopLoss: 1.09970, atrPrice: 0.0020,
  }));
  check("tight stop → survivesNormalPullback false", tight.survivability.survivesNormalPullback === false);
  check("tight stop → low survivability score", tight.survivability.score < 50);
  check("tight stop → a non-blocking warning is surfaced", tight.warnings.length > 0);

  // Roomy stop: 0.0050 away (2.5 ATR) → strong room.
  const roomy = estimateExecutionPreview(baseInput({
    entry: 1.10010, stopLoss: 1.09510, atrPrice: 0.0020,
  }));
  check("roomy stop → survivesStructureInvalidation true",
    roomy.survivability.survivesStructureInvalidation === true);
  check("roomy stop → higher survivability than tight",
    roomy.survivability.score > tight.survivability.score);
}

// ── 7. Broker BLOCK when symbol not tradable → reasons become blockers ────────
{
  const disabledSpec: BrokerSpec = { ...fxSpec, tradeAllowed: false };
  const p = estimateExecutionPreview(baseInput({ spec: disabledSpec }));
  check("not-tradable → broker verdict BLOCK", p.brokerCondition.verdict === "BLOCK");
  check("BLOCK reasons promoted to blockers", p.blockers.length > 0);

  // Spread blow-out → DOWNGRADE (advisory), not a block.
  const wide = estimateExecutionPreview(baseInput({
    quote: { bid: 1.10000, ask: 1.10500, quoteAgeMs: 500 }, maxSpreadPoints: 50,
  }));
  check("spread over tolerance → DOWNGRADE", wide.brokerCondition.verdict === "DOWNGRADE");
}

// ── 7b. Directionally-invalid SL/TP → honest blocker, never priced ────────────
{
  // BUY with TP BELOW entry and SL ABOVE entry — both on the wrong side.
  const inverted = estimateExecutionPreview(baseInput({
    side: "BUY", entry: 1.10010, stopLoss: 1.10510, takeProfit: 1.09510,
  }));
  check("inverted BUY → at least two blockers raised", inverted.blockers.length >= 2);
  check("inverted BUY → after-cost loss not priced", inverted.afterCost.stopLossMoney == null);
  check("inverted BUY → after-cost gain not priced", inverted.afterCost.takeProfitMoney == null);
  check("inverted BUY → no reward:risk shown", inverted.afterCost.riskRewardRatio == null);
  check("inverted BUY → wrong-side stop not scored survivable",
    inverted.survivability.survivesNormalPullback == null && inverted.survivability.score === 0);
  check("inverted BUY → risk money not computed from wrong-side stop",
    inverted.accountImpact.riskMoney == null);

  // SELL mirror: a valid SELL has SL above, TP below — invert it.
  const invSell = estimateExecutionPreview(baseInput({
    side: "SELL", entry: 1.10010, stopLoss: 1.09510, takeProfit: 1.10510,
  }));
  check("inverted SELL → blockers raised", invSell.blockers.length >= 2);
  check("inverted SELL → no reward:risk shown", invSell.afterCost.riskRewardRatio == null);

  // A correctly-sided SELL still prices normally (regression guard).
  const goodSell = estimateExecutionPreview(baseInput({
    side: "SELL", entry: 1.10000, stopLoss: 1.10500, takeProfit: 1.09000, atrPrice: 0.0020,
  }));
  check("valid SELL → reward:risk is priced", goodSell.afterCost.riskRewardRatio != null);
  check("valid SELL → no directional blocker", goodSell.blockers.length === 0);

  // Mixed validity: BUY with a VALID stop (below) but an INVALID target (below).
  // The good leg still prices; the bad leg is nulled; R:R can't form on one leg.
  const mixedBadTp = estimateExecutionPreview(baseInput({
    side: "BUY", entry: 1.10010, stopLoss: 1.09510, takeProfit: 1.09000, atrPrice: 0.0020,
  }));
  check("mixed (good SL, bad TP) → valid stop still priced",
    mixedBadTp.afterCost.stopLossMoney != null);
  check("mixed (good SL, bad TP) → bad target not priced",
    mixedBadTp.afterCost.takeProfitMoney == null);
  check("mixed (good SL, bad TP) → no reward:risk on one leg",
    mixedBadTp.afterCost.riskRewardRatio == null);
  check("mixed (good SL, bad TP) → exactly one directional blocker",
    mixedBadTp.blockers.length === 1);
  check("mixed (good SL, bad TP) → good stop still scored survivable",
    mixedBadTp.survivability.survivesNormalPullback != null);

  // Mixed validity: BUY with a VALID target (above) but an INVALID stop (above).
  const mixedBadSl = estimateExecutionPreview(baseInput({
    side: "BUY", entry: 1.10010, stopLoss: 1.10500, takeProfit: 1.11010, atrPrice: 0.0020,
  }));
  check("mixed (bad SL, good TP) → valid target still priced",
    mixedBadSl.afterCost.takeProfitMoney != null);
  check("mixed (bad SL, good TP) → bad stop not priced",
    mixedBadSl.afterCost.stopLossMoney == null);
  check("mixed (bad SL, good TP) → wrong-side stop not scored survivable",
    mixedBadSl.survivability.survivesNormalPullback == null);
}

// ── 8. No internal UPPER_SNAKE enum tokens in user-facing strings ─────────────
{
  // Exercise every copy surface across several scenarios.
  const inputs = [
    baseInput({ entry: 1.10010, stopLoss: 1.09510, takeProfit: 1.11010 }),
    baseInput({ spec: { ...fxSpec, tradeAllowed: false } }),
    baseInput({ openExposure: { openLots: 0.5, positionCount: 1, netSide: "SELL" } }),
    baseInput({ hasBrokerTruth: false, spec: {
      visible: null, tradeAllowed: null, tradeMode: null, marketOpen: null,
      point: null, minVolume: null, maxVolume: null, volumeStep: null,
      stopsLevelPoints: null, freezeLevelPoints: null,
    } }),
    baseInput({ quote: { bid: null, ask: null, quoteAgeMs: null }, atrPrice: null }),
  ];
  const strings: string[] = [];
  for (const inp of inputs) {
    const p = estimateExecutionPreview(inp);
    strings.push(
      p.slippage.note, p.survivability.note, p.accountImpact.note, p.disclaimer,
      ...p.brokerCondition.reasons, ...p.blockers, ...p.warnings, ...p.dataQuality.notes,
      ...p.orderTypes.map((o) => o.note),
      ...(p.multiEntry ? [p.multiEntry.scalingNote] : []),
    );
  }
  // UPPER_SNAKE = two+ caps, an underscore, then two+ caps (e.g. LIVE_BLOCKED).
  const tokenRe = /\b[A-Z]{2,}_[A-Z][A-Z_]+\b/;
  const leaked = strings.filter((s) => typeof s === "string" && tokenRe.test(s));
  check("no UPPER_SNAKE tokens leak into user-facing strings",
    leaked.length === 0 || (console.error("   leaked:", leaked), false));
  // Specific internal tokens must never appear.
  const banned = ["SPREAD_FALLBACK", "VOLATILITY_FALLBACK", "LIVE_BLOCKED", "CLOSEONLY", "LONGONLY", "tradeMode"];
  const bannedHit = strings.filter((s) => typeof s === "string" && banned.some((b) => s.includes(b)));
  check("no banned internal identifiers in copy",
    bannedHit.length === 0 || (console.error("   banned hit:", bannedHit), false));
}

// ── Determinism: same input → identical output ────────────────────────────────
{
  const a = JSON.stringify(estimateExecutionPreview(baseInput({ entry: 1.10010, stopLoss: 1.09510 })));
  const b = JSON.stringify(estimateExecutionPreview(baseInput({ entry: 1.10010, stopLoss: 1.09510 })));
  check("estimator is deterministic", a === b);
}

if (failures > 0) {
  console.error(`\nexecutionPreviewTest: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nexecutionPreviewTest: all checks passed");
