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

// ── Finding: every ANY-mode scalp was badged "Sniper Scalp" ────────────────

/** A scanner row as the production scanner emits it (no trendStrength field). */
function productionScannerRow(): Record<string, unknown> {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: 80,
    entrySniperScore: 78,
    setupType: "Continuation",
    entry: 1.085,
    stopLoss: 1.083,
    takeProfit: 1.089,
    reasonForTrade: "Upward drift",
    reasonToAvoid: "",
    dataSource: "LIVE_FEED",
    sufficiency: sufficientVerdict(),
    newsContext: null,
    generatedAt: new Date(NOW).toISOString(),
  };
}

function eurUsdTickSpec(): ScalpSpecInput {
  return usdJpySpec({
    digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1, profitCurrency: "USD", displayName: "EURUSD",
  });
}

async function productionScalp(mode: ScalpEngineInput["mode"]) {
  const { oppToScannerInput } = await import("../scalpService.js");
  const scanner = oppToScannerInput(productionScannerRow() as never);
  assert.equal(scanner.trendStrength, undefined, "the production scanner row carries no trend measure");
  return evaluateScalp(usdJpyInput({
    symbol: "EURUSD",
    currentPrice: 1.085,
    spec: eurUsdTickSpec(),
    scanner,
    mode,
  }));
}

test("scalp type: ANY mode with no trend measure is a plain 'Scalp', never 'Sniper Scalp'", async () => {
  const r = await productionScalp("ANY");
  assert.notEqual(r.scalpType, "Sniper Scalp", "the Sniper floor was not applied in ANY mode");
  assert.equal(r.scalpType, "Scalp");
});

test("scalp type: ANY mode with a measured mid trend is still not 'Sniper Scalp'", () => {
  const r = evaluateScalp(usdJpyInput({
    symbol: "EURUSD",
    currentPrice: 1.085,
    spec: eurUsdTickSpec(),
    scanner: usdJpyScanner({ entry: 1.085, stopLoss: 1.083, takeProfit: 1.089, entryZone: { low: 1.0848, high: 1.0852 }, trendStrength: 50 }),
  }));
  assert.equal(r.scalpType, "Scalp");
});

test("scalp type: MOMENTUM / REVERSAL modes with no trend measure say the trend was not measured and get no tilt", async () => {
  const any = await productionScalp("ANY");
  const momentum = await productionScalp("MOMENTUM");
  const reversal = await productionScalp("REVERSAL");
  assert.equal(momentum.scalpType, "Scalp (trend not measured)");
  assert.equal(reversal.scalpType, "Scalp (trend not measured)");
  // No trend characteristic was measured, so neither mode may move the score.
  assert.equal(momentum.qualityScore, any.qualityScore);
  assert.equal(reversal.qualityScore, any.qualityScore, "REVERSAL used to add +1.5 from an assumed trend of 50");
});

test("scalp type: a measured trend still drives the MOMENTUM label and tilt", () => {
  const scanner = usdJpyScanner({ entry: 1.085, stopLoss: 1.083, takeProfit: 1.089, entryZone: { low: 1.0848, high: 1.0852 } });
  const base = { symbol: "EURUSD", currentPrice: 1.085, spec: eurUsdTickSpec() };
  const weak = evaluateScalp(usdJpyInput({ ...base, mode: "MOMENTUM", scanner: { ...scanner, trendStrength: 50 } }));
  const strong = evaluateScalp(usdJpyInput({ ...base, mode: "MOMENTUM", scanner: { ...scanner, trendStrength: 80 } }));
  assert.equal(strong.scalpType, "Momentum Scalp");
  assert.ok(strong.qualityScore > weak.qualityScore);
});

// ── Finding: READY text claimed a support/resistance reaction ──────────────

/** Steady drift with no swing high/low near price: no level to react to. */
function driftCandles(start: number, step: number, n = 40) {
  const out: { open: number; high: number; low: number; close: number }[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + step;
    out.push({ open: o, high: Math.max(o, c) + Math.abs(step) * 0.2, low: Math.min(o, c) - Math.abs(step) * 0.2, close: c });
    p = c;
  }
  return out;
}

for (const side of ["BUY", "SELL"] as const) {
  test(`reason copy: a READY ${side} scalp does not claim a support/resistance reaction nobody measured`, () => {
    const buy = side === "BUY";
    const scanner = usdJpyScanner({
      bias: buy ? "bullish" : "bearish",
      recommendedAction: side,
      entry: 1.085,
      stopLoss: buy ? 1.083 : 1.087,
      takeProfit: buy ? 1.089 : 1.081,
      entryZone: { low: 1.0848, high: 1.0852 },
    });
    let ready = 0;
    for (const candles of [null, driftCandles(1.084, buy ? 0.00002 : -0.00002)]) {
      const r = evaluateScalp(usdJpyInput({
        symbol: "EURUSD",
        currentPrice: 1.085,
        spec: eurUsdTickSpec(),
        scanner,
        candles: candles ?? undefined,
      }));
      if (r.status !== "READY") continue;
      ready += 1;
      assert.doesNotMatch(r.plainEnglishReason, /reacting to|before the next (resistance|support)|other side of that level/i);
      assert.doesNotMatch(r.plainEnglishReason, /\b(support|resistance)\b(?! (and resistance |or resistance )?(levels? )?(were|was) not checked)/i);
      // It says what was actually used: the stop and the reward-to-risk.
      assert.match(r.plainEnglishReason, new RegExp(String(r.stopLoss)));
      assert.match(r.plainEnglishReason, /reward to risk/i);
      assert.match(r.plainEnglishReason, /not checked/i);
    }
    assert.ok(ready >= 1, "at least one fixture reaches READY");
  });
}

// ── Finding: engine fell back to 2 digits, manage side to 5 ────────────────

function eurUsdNoDigitsInput(spec: Partial<ScalpSpecInput>): ScalpEngineInput {
  return usdJpyInput({
    symbol: "EURUSD",
    currentPrice: 1.08523,
    spec: usdJpySpec({ tickSize: 0.00001, tickValue: 1, profitCurrency: "USD", displayName: "EURUSD", ...spec }),
    scanner: usdJpyScanner({ entry: 1.08523, stopLoss: 1.08323, takeProfit: 1.08923, entryZone: { low: 1.08503, high: 1.08543 } }),
  });
}

function decimals(v: number): number {
  const s = String(v);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
}

test("precision: no digits and no point → no levels are invented", () => {
  const r = evaluateScalp(eurUsdNoDigitsInput({ digits: null, point: null }));
  // Before the fix: digits fell back to 2, so the card read "SL 1.08, TP 1.09"
  // and the min-stop floor became 0.10 (1,000 pips).
  assert.equal(r.digits, null);
  assert.equal(r.stopLoss, null);
  assert.equal(r.takeProfit.main, null);
  assert.equal(r.entryZone, null);
  assert.equal(r.canBuildTrade, false);
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.rejectReason, "NO_SPECS");
  assert.match(r.plainEnglishReason, /precision/i);
});

test("precision: digits missing but point reported → digits come from the point size", () => {
  const r = evaluateScalp(eurUsdNoDigitsInput({ digits: null, point: 0.00001 }));
  assert.equal(r.digits, 5);
  assert.equal(r.status, "READY");
  assert.ok(r.stopLoss != null && Math.abs(r.stopLoss - 1.08323) < 1e-9, `stop at 5 dp, got ${r.stopLoss}`);
  assert.ok(decimals(r.stopLoss!) > 2);
});

test("precision: entry and manage sides resolve the same precision from one spec", async () => {
  const { resolveScalpPricePrecision } = await import("../scalpPrecision.js");
  const { readManageFlame } = await import("../scalpManageService.js");
  for (const spec of [
    { digits: null, point: 0.00001 },
    { digits: 3, point: null },
    { digits: null, point: 0.25 },
    { digits: null, point: null },
  ]) {
    const full = usdJpySpec({ tickSize: 0.00001, tickValue: 1, ...spec });
    const p = resolveScalpPricePrecision(full);
    const flame = readManageFlame("BUY", null, full, null, {
      averageEntry: 1.08523, currentPrice: 1.08523, stopLoss: 1.08323, takeProfit: 1.08923,
    }, "BALANCED");
    const quoted = /through ([0-9.]+)/.exec(flame.invalidationIdea ?? "")?.[1];
    assert.ok(quoted, `manage read quotes the invalidation price (${JSON.stringify(spec)})`);
    if (p) {
      assert.equal(decimals(Number(quoted)) <= p.digits, true);
      assert.equal(quoted!.split(".")[1]?.length ?? 0, p.digits, `manage uses the engine's ${p.digits} digits for ${JSON.stringify(spec)}`);
    } else {
      // Unknown precision: the broker's price as reported, not padded to an invented 5 dp.
      assert.equal(quoted, "1.08323");
    }
  }
  assert.deepEqual(resolveScalpPricePrecision({ digits: null, point: 0.25 }), { digits: 2, point: 0.25 });
  assert.equal(resolveScalpPricePrecision({ digits: null, point: null }), null);
});
