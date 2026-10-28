// Scalp truth-accuracy regressions: the scalp card's money tiles, lot,
// type badge, reason copy and price precision must describe what the engine
// actually measured. Run via:
//   node --import tsx --test --test-force-exit src/lib/scalp/__qa__/scalpTruthAccuracy.test.ts
// (wired into `pnpm --filter @workspace/api-server run test:truth-component-evidence`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import { evaluateScalp } from "../scalpEngine.js";
import type {
  ScalpEngineInput,
  ScalpScannerInput,
  ScalpSpecInput,
} from "../scalpTypes.js";

const NOW = 1_780_000_000_000;

function sufficientVerdict() {
  return evaluateMarketDataSufficiency({
    symbol: "EURUSD",
    timeframe: "M5",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 300,
  });
}

/** USDJPY as an EA reports it when tickValue/tickSize were not sent. */
function usdJpySpec(over: Partial<ScalpSpecInput> = {}): ScalpSpecInput {
  return {
    hasBrokerTruth: true,
    tradeMode: "FULL",
    tradeAllowed: true,
    visible: true,
    marketOpen: true,
    digits: 3,
    point: 0.001,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    contractSize: 100000,
    tickSize: null,
    tickValue: null,
    stopsLevelPoints: 0,
    spreadPoints: 10,
    category: "forex",
    displayName: "USDJPY",
    profitCurrency: "JPY",
    ...over,
  };
}

/** A clean in-zone BUY read with a 0.20 stop distance on USDJPY. */
function usdJpyScanner(over: Partial<ScalpScannerInput> = {}): ScalpScannerInput {
  return {
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: 82,
    entrySniperScore: 80,
    setupType: "Continuation",
    entry: 150.0,
    stopLoss: 149.8,
    takeProfit: 150.4,
    entryZone: { low: 149.98, high: 150.02 },
    dataSource: "LIVE_FEED",
    sufficiency: sufficientVerdict(),
    ...over,
  };
}

function usdJpyInput(over: Partial<ScalpEngineInput> = {}): ScalpEngineInput {
  return {
    symbol: "USDJPY",
    currentPrice: 150.0,
    spec: usdJpySpec(),
    scanner: usdJpyScanner(),
    account: { balance: 10000, equity: 10000, freeMargin: 10000, leverage: 100, currency: "USD" },
    mode: "ANY",
    riskAmount: 100,
    now: NOW,
    ...over,
  };
}

// ── Finding: money tiles were in the symbol's profit currency ──────────────

test("money: no tick value + profit currency differs from account → no lot and no money figures", () => {
  const r = evaluateScalp(usdJpyInput());
  // Before the fix: contractSize fallback sized the lot in JPY against a USD
  // budget (perLotRisk ¥20,000) and reported estimatedRiskAmount ≈ 100 "JPY"
  // as if it were dollars, with a lot ~150× too small.
  assert.equal(r.suggestedLot, null, "no lot can be sized without a money value per point in account currency");
  assert.equal(r.estimatedRiskAmount, null);
  assert.equal(r.estimatedProfitMainTP, null);
  assert.equal(r.estimatedMargin, null);
  assert.equal(r.canBuildTrade, false);
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.rejectReason, "NO_SPECS");
  assert.match(r.plainEnglishReason, /tick value/i);
  assert.match(r.plainEnglishReason, /JPY/);
});

test("money: no tick value + profit currency unknown → no lot and no money figures", () => {
  const r = evaluateScalp(usdJpyInput({ spec: usdJpySpec({ profitCurrency: null }) }));
  assert.equal(r.suggestedLot, null);
  assert.equal(r.estimatedRiskAmount, null);
  assert.equal(r.status, "AWAITING_DATA");
});

test("money: no tick value + account currency unknown → no lot and no money figures", () => {
  const r = evaluateScalp(usdJpyInput({
    spec: usdJpySpec({ profitCurrency: "USD" }),
    account: { balance: 10000, equity: 10000, freeMargin: 10000, leverage: 100, currency: null },
  }));
  assert.equal(r.suggestedLot, null);
  assert.equal(r.estimatedRiskAmount, null);
  assert.equal(r.moneyCurrency, null);
});

test("money: no tick value but profit currency equals account currency → contract-size sizing in that currency", () => {
  // EURUSD on a USD account: 1.0 price move per lot = 100000 USD.
  const r = evaluateScalp(usdJpyInput({
    symbol: "EURUSD",
    currentPrice: 1.085,
    spec: usdJpySpec({ digits: 5, point: 0.00001, profitCurrency: "USD", displayName: "EURUSD" }),
    scanner: usdJpyScanner({ entry: 1.085, stopLoss: 1.083, takeProfit: 1.089, entryZone: { low: 1.0848, high: 1.0852 } }),
  }));
  assert.equal(r.status, "READY");
  assert.equal(r.moneyCurrency, "USD");
  assert.ok(r.estimatedRiskAmount != null && Math.abs(r.estimatedRiskAmount - 100) <= 1, `risk ≈ 100 USD, got ${r.estimatedRiskAmount}`);
  assert.equal(r.suggestedLot, 0.5);
});

test("money: tick truth sizes in account currency and margin is converted out of the profit currency", () => {
  // USDJPY on a USD account at 150: tickValue (USD) = 0.001 × 100000 / 150.
  const tickValue = (0.001 * 100000) / 150;
  const r = evaluateScalp(usdJpyInput({ spec: usdJpySpec({ tickSize: 0.001, tickValue }) }));
  assert.equal(r.status, "READY");
  assert.equal(r.moneyCurrency, "USD");
  assert.ok(r.estimatedRiskAmount != null && Math.abs(r.estimatedRiskAmount - 100) <= 1, `risk ≈ 100 USD, got ${r.estimatedRiskAmount}`);
  assert.equal(r.suggestedLot, 0.75);
  // Margin for 0.75 lot USDJPY at 1:100 = 0.75 × 100000 USD / 100 = 750 USD,
  // not 0.75 × 100000 × 150 / 100 = 112,500 (yen).
  assert.ok(r.estimatedMargin != null && Math.abs(r.estimatedMargin - 750) <= 1, `margin ≈ 750 USD, got ${r.estimatedMargin}`);
});
