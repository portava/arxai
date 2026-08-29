// Profit Mission Phase 7 — pure execution-quality / net-profit / exposure /
// capital-efficiency / broker-feed-health domain contract tests.
//
// These engines are BLOCK/DOWNGRADE ONLY: a verdict can refuse or downgrade a
// setup but can NEVER upgrade a refused setup into a tradeable one, and can
// never relax the downstream 23-gate dispatch. They are pure and IO-free —
// identical inputs always produce identical output, so an honest "unknown"
// never silently reads as "good"/"normal". Tests 27,28,29,30,33,34,35,36,37.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeExecutionQuality,
  computeNetProfitVerdict,
  evaluateExposure,
  aggregateExposure,
  computeCapitalEfficiency,
  rankByCapitalEfficiency,
  composeExecutionHealthGate,
  checkMissionCopyDeep,
  type ExecutionQualityInput,
  type ExecutionHealthInput,
  type ExposurePosition,
} from "@workspace/domain/profit-mission";

// A strong, otherwise-clean scalp setup; individual tests perturb one field.
function scalpInput(over: Partial<ExecutionQualityInput> = {}): ExecutionQualityInput {
  return {
    isScalp: true,
    direction: "BUY",
    quoteFreshness: "fresh",
    spreadPips: 0.6,
    expectedMovePips: 10,
    atrPips: 12,
    volumeRatio: 1.2,
    serverLatencyMs: 120,
    signalAgeMs: 1_000,
    maxSignalAgeMs: 60_000,
    pipSize: 0.0001,
    intendedPrice: 1.1,
    sizeLots: 0.1,
    ...over,
  };
}

function healthInput(over: Partial<ExecutionHealthInput> = {}): ExecutionHealthInput {
  return {
    brokerSeverity: "ok",
    brokerConnected: true,
    feedStatus: "live",
    quoteCandleAligned: true,
    spread: "normal",
    ghostPosition: false,
    equityReconciled: true,
    routeHealthy: true,
    ...over,
  };
}

function pos(over: Partial<ExposurePosition> = {}): ExposurePosition {
  return {
    symbol: "EURUSD",
    assetClass: "forex_major",
    currencies: ["EUR", "USD"],
    direction: "BUY",
    riskAmount: 50,
    ...over,
  };
}

// ── Test 27 — wide spread blocks a scalp even with an otherwise strong setup. ─
test("27: wide spread eats the edge and blocks a scalp", () => {
  // Spread 3p on a 10p target = 30% of the move → over the 25% scalp block.
  const v = computeExecutionQuality(scalpInput({ spreadPips: 3, expectedMovePips: 10 }));
  assert.equal(v.allowed, false);
  assert.equal(v.spreadStatus, "extreme");
  assert.ok(v.blockers.includes("SPREAD_EATS_EDGE"));

  // The very same spread on a swing (50p target) is tolerable — proves the
  // scalp-stricter behavior, not a blanket block.
  const swing = computeExecutionQuality(
    scalpInput({ isScalp: false, spreadPips: 3, expectedMovePips: 50 }),
  );
  assert.equal(swing.allowed, true);
  assert.ok(!swing.blockers.includes("SPREAD_EATS_EDGE"));
});

// ── Test 28 — stale / unknown quote blocks execution (fail-closed feed truth). ─
test("28: stale quote blocks execution; unknown quote also fails closed", () => {
  const stale = computeExecutionQuality(scalpInput({ quoteFreshness: "stale" }));
  assert.equal(stale.allowed, false);
  assert.ok(stale.blockers.includes("QUOTE_STALE"));

  const unknown = computeExecutionQuality(scalpInput({ quoteFreshness: "unknown" }));
  assert.equal(unknown.allowed, false);
  assert.ok(unknown.blockers.includes("QUOTE_UNCONFIRMED"));
  // Honest unknown must never read as a fresh/good quote.
  assert.equal(unknown.quoteFreshness, "unknown");
});

// ── Test 29 — high estimated slippage blocks. ────────────────────────────────
test("29: high estimated slippage blocks the trade", () => {
  // News window + thin liquidity + wide spread + high latency drive the
  // execution-realism slippage estimate over the scalp ceiling.
  const v = computeExecutionQuality(
    scalpInput({
      spreadPips: 2.2,
      expectedMovePips: 40, // keep spread share low so SLIPPAGE is the blocker
      atrPips: 40,
      volumeRatio: 0.2,
      isNewsWindow: true,
      serverLatencyMs: 400,
    }),
  );
  assert.equal(v.allowed, false);
  assert.ok(v.blockers.includes("SLIPPAGE_HIGH"));
  assert.equal(v.slippageRisk, "high");
  assert.ok(v.estimatedSlippagePips != null && v.estimatedSlippagePips > 0);
});

// ── Test 30 — net-profit filter rejects a low-profit / high-cost scalp. ──────
test("30: net-profit filter rejects a low-profit, high-cost scalp", () => {
  // Target 12, costs 10 → net 2, ratio 0.2× — far below the 2× scalp floor.
  const v = computeNetProfitVerdict({
    isScalp: true,
    assetClass: "forex_major",
    targetProfit: 12,
    riskAmount: 50,
    spreadCost: 5,
    estimatedSlippageCost: 3,
    commission: 2,
  });
  assert.equal(v.allowed, false);
  assert.ok(v.blockers.includes("NET_PROFIT_TOO_LOW") || v.blockers.includes("COST_EXCEEDS_TARGET"));
  assert.equal(v.estimatedTotalCost, 10);

  // A healthy scalp (target 60 vs 10 cost = 5×) passes — proves it's a filter,
  // not a blanket block.
  const ok = computeNetProfitVerdict({
    isScalp: true,
    assetClass: "forex_major",
    targetProfit: 60,
    spreadCost: 5,
    estimatedSlippageCost: 3,
    commission: 2,
  });
  assert.equal(ok.allowed, true);

  // Unknown target fails closed (never fabricates a clearing trade).
  const noTarget = computeNetProfitVerdict({
    isScalp: true,
    assetClass: "forex_major",
    targetProfit: null,
    spreadCost: 5,
  });
  assert.equal(noTarget.allowed, false);
  assert.ok(noTarget.blockers.includes("NET_PROFIT_UNVERIFIED"));
});

// ── Test 33 — broker/feed health failure blocks execution; analyze stays ok. ─
test("33: broker/feed health failure blocks execution, analyze always allowed", () => {
  const brokerDown = composeExecutionHealthGate(healthInput({ brokerSeverity: "danger" }));
  assert.equal(brokerDown.executionAllowed, false);
  assert.equal(brokerDown.analyzeAllowed, true);
  assert.ok(brokerDown.blockers.includes("BROKER_HEALTH_DANGER"));

  const feedStale = composeExecutionHealthGate(healthInput({ feedStatus: "stale" }));
  assert.equal(feedStale.executionAllowed, false);
  assert.equal(feedStale.analyzeAllowed, true);
  assert.ok(feedStale.blockers.includes("FEED_STALE"));

  // Unknown broker health fails closed — never reads as healthy.
  const unknown = composeExecutionHealthGate(
    healthInput({ brokerSeverity: "unknown", brokerConnected: null }),
  );
  assert.equal(unknown.executionAllowed, false);
  assert.ok(unknown.blockers.includes("BROKER_HEALTH_UNKNOWN"));

  // A fully-healthy snapshot is the only one that permits execution.
  const healthy = composeExecutionHealthGate(healthInput());
  assert.equal(healthy.executionAllowed, true);
});

// ── Test 34 — quote/candle mismatch blocks. ──────────────────────────────────
test("34: quote/candle mismatch blocks execution; unverified also fails closed", () => {
  const mismatch = composeExecutionHealthGate(healthInput({ quoteCandleAligned: false }));
  assert.equal(mismatch.executionAllowed, false);
  assert.ok(mismatch.blockers.includes("QUOTE_CANDLE_MISMATCH"));

  const unverified = composeExecutionHealthGate(healthInput({ quoteCandleAligned: null }));
  assert.equal(unverified.executionAllowed, false);
  assert.ok(unverified.blockers.includes("QUOTE_CANDLE_UNVERIFIED"));
});

// ── Test 35 — correlated exposure blocks duplicate / correlated risk. ────────
test("35: correlated exposure blocks duplicate and same-currency risk", () => {
  // Duplicate same-symbol same-direction over a cap of 1.
  const dup = evaluateExposure({
    open: [pos()],
    proposed: pos(),
    budget: { maxSameSymbolExposure: 1, maxCorrelatedExposure: 5 },
  });
  assert.equal(dup.allowed, false);
  assert.ok(dup.blockers.includes("DUPLICATE_SYMBOL_DIRECTION"));

  // Shared-currency same-direction stacking over the correlated cap.
  const ccy = evaluateExposure({
    open: [pos({ symbol: "EURGBP", currencies: ["EUR", "GBP"] })],
    proposed: pos({ symbol: "EURUSD", currencies: ["EUR", "USD"] }),
    budget: { maxSameSymbolExposure: 5, maxCorrelatedExposure: 1 },
  });
  assert.equal(ccy.allowed, false);
  assert.ok(
    ccy.blockers.includes("CURRENCY_OVEREXPOSURE") ||
      ccy.blockers.includes("CORRELATED_OVEREXPOSURE"),
  );
});

// ── Test 36 — exposure manager blocks overexposure (max trades + amount). ────
test("36: exposure manager blocks max-open-trades and mission overexposure", () => {
  const maxTrades = evaluateExposure({
    open: [pos({ symbol: "GBPUSD" }), pos({ symbol: "USDJPY", currencies: ["USD", "JPY"] })],
    proposed: pos({ symbol: "AUDUSD", currencies: ["AUD", "USD"] }),
    budget: { maxSameSymbolExposure: 5, maxCorrelatedExposure: 9, maxOpenTrades: 2 },
  });
  assert.equal(maxTrades.allowed, false);
  assert.ok(maxTrades.blockers.includes("MAX_OPEN_TRADES"));

  const overRisk = evaluateExposure({
    open: [pos({ symbol: "GBPUSD", riskAmount: 80 })],
    proposed: pos({ symbol: "AUDUSD", currencies: ["AUD", "USD"], riskAmount: 80 }),
    budget: {
      maxSameSymbolExposure: 5,
      maxCorrelatedExposure: 9,
      maxMissionExposureAmount: 100,
    },
  });
  assert.equal(overRisk.allowed, false);
  assert.ok(overRisk.blockers.includes("MISSION_OVEREXPOSURE"));

  // Aggregate helper reflects the full open picture for the Judge/UI.
  const agg = aggregateExposure([pos({ riskAmount: 30 }), pos({ symbol: "XAUUSD", assetClass: "metal", riskAmount: 70 })]);
  assert.equal(agg.openCount, 2);
  assert.equal(agg.totalOpenRisk, 100);
  assert.equal(agg.countByAssetClass["forex_major"], 1);
  assert.equal(agg.riskByAssetClass["metal"], 70);
});

// ── Test 37 — capital efficiency ranks a better risk-adjusted setup higher. ──
test("37: capital efficiency ranks the better risk-adjusted setup higher", () => {
  const strong = computeCapitalEfficiency({
    expectedR: 3,
    riskAmount: 50,
    estimatedProfit: 150,
    marginRequired: 500,
    expectedHoldHours: 2,
    missionHoursRemaining: 48,
  });
  const weak = computeCapitalEfficiency({
    expectedR: 1,
    riskAmount: 50,
    estimatedProfit: 50,
    marginRequired: 2000,
    expectedHoldHours: 20,
    missionHoursRemaining: 48,
  });
  assert.ok(strong.score > weak.score);
  assert.equal(strong.efficient, true);

  const ranked = rankByCapitalEfficiency(
    [
      { id: "weak", inp: weak },
      { id: "strong", inp: strong },
    ],
    (x) =>
      x.id === "strong"
        ? { expectedR: 3, riskAmount: 50, estimatedProfit: 150, marginRequired: 500, expectedHoldHours: 2, missionHoursRemaining: 48 }
        : { expectedR: 1, riskAmount: 50, estimatedProfit: 50, marginRequired: 2000, expectedHoldHours: 20, missionHoursRemaining: 48 },
  );
  assert.equal(ranked[0].item.id, "strong");

  // Downgrade-only: a slow trade that won't resolve before the mission ends is
  // pushed below the efficiency floor but is never itself a hard block.
  const slow = computeCapitalEfficiency({
    expectedR: 3,
    riskAmount: 50,
    estimatedProfit: 150,
    expectedHoldHours: 100,
    missionHoursRemaining: 5,
  });
  assert.equal(slow.efficient, false);

  // No usable inputs → honest unknown, never a fabricated positive score.
  const unknown = computeCapitalEfficiency({});
  assert.equal(unknown.score, 0);
  assert.equal(unknown.efficient, false);
  assert.match(unknown.reason, /unknown/i);
});

// ── Honesty guard — no banned guaranteed-profit vocabulary in any verdict copy. ─
test("Phase 7 verdict copy carries no guaranteed-profit vocabulary", () => {
  const copy = [
    computeExecutionQuality(scalpInput({ quoteFreshness: "stale" })),
    computeExecutionQuality(scalpInput({ spreadPips: 3, expectedMovePips: 10 })),
    computeNetProfitVerdict({ isScalp: true, assetClass: "metal", targetProfit: 12, spreadCost: 5, estimatedSlippageCost: 3, commission: 2 }),
    evaluateExposure({ open: [pos()], proposed: pos(), budget: { maxSameSymbolExposure: 1, maxCorrelatedExposure: 5 } }),
    composeExecutionHealthGate(healthInput({ feedStatus: "simulator" })),
    computeCapitalEfficiency({ expectedR: 1, riskAmount: 50, estimatedProfit: 50, marginRequired: 2000 }),
  ];
  const result = checkMissionCopyDeep(copy);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});
