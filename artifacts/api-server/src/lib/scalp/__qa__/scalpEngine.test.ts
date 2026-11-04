// Unit tests for the shared scalp engine. Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-engine`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import { evaluateScalp } from "../scalpEngine.js";
import type {
  ScalpEngineInput,
  ScalpSpecInput,
  ScalpScannerInput,
  ScalpCandle,
} from "../scalpTypes.js";

const NOW = 1_780_000_000_000;

// The REAL shared sufficiency verdict (not hand-built) — a live feed with
// plenty of closed bars on an approved market. The engine fail-closes when
// this is absent, so every actionable-path builder must carry it.
function sufficientVerdict() {
  return evaluateMarketDataSufficiency({
    symbol: "Volatility 75 Index",
    timeframe: "M5",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 300,
  });
}

// The REAL insufficient verdict (thin feed) for the fail-closed tests.
function insufficientVerdict() {
  return evaluateMarketDataSufficiency({
    symbol: "Volatility 75 Index",
    timeframe: "M5",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 1,
  });
}

// A clean, broker-truth synthetic spec (V75-like): tickValue/tickSize give an
// exact $ per price unit per lot.
function v75Spec(over: Partial<ScalpSpecInput> = {}): ScalpSpecInput {
  return {
    hasBrokerTruth: true,
    tradeMode: "FULL",
    tradeAllowed: true,
    visible: true,
    marketOpen: true,
    digits: 2,
    point: 0.01,
    minLot: 0.001,
    maxLot: 10,
    lotStep: 0.001,
    contractSize: 1,
    tickSize: 0.01,
    tickValue: 0.01, // => $1 per 1.0 price move per lot
    stopsLevelPoints: 0,
    spreadPoints: 20, // 0.20 price
    category: "synthetic",
    displayName: "Volatility 75 Index",
    ...over,
  };
}

// A clean SELL scanner read in the entry zone (price between entry zone bounds).
function sellScanner(over: Partial<ScalpScannerInput> = {}): ScalpScannerInput {
  return {
    bias: "bearish",
    recommendedAction: "SELL",
    confidenceScore: 84,
    entrySniperScore: 82,
    trendStrength: 45,
    setupType: "Rejection",
    entry: 4605,
    stopLoss: 4628,
    takeProfit: 4580,
    entryZone: { low: 4602, high: 4608 },
    dataSource: "LIVE_FEED",
    sufficiency: sufficientVerdict(),
    reasonForTrade: "Rejection from resistance",
    ...over,
  };
}

function buyScanner(over: Partial<ScalpScannerInput> = {}): ScalpScannerInput {
  return {
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: 82,
    entrySniperScore: 80,
    trendStrength: 62,
    setupType: "Continuation",
    entry: 4600,
    stopLoss: 4585,
    takeProfit: 4625,
    entryZone: { low: 4597, high: 4603 },
    dataSource: "LIVE_FEED",
    sufficiency: sufficientVerdict(),
    reasonForTrade: "Support hold",
    ...over,
  };
}

function baseInput(over: Partial<ScalpEngineInput> = {}): ScalpEngineInput {
  return {
    symbol: "Volatility 75 Index",
    currentPrice: 4605,
    spec: v75Spec(),
    scanner: sellScanner(),
    account: { balance: 1000, equity: 1000, freeMargin: 1000, leverage: 100 },
    mode: "ANY",
    riskAmount: 10,
    now: NOW,
    ...over,
  };
}

test("READY: clean in-zone setup is tradeable with full numbers", () => {
  const r = evaluateScalp(baseInput());
  assert.equal(r.status, "READY");
  assert.equal(r.direction, "SELL");
  assert.equal(r.canBuildTrade, true);
  assert.equal(r.timingStatus, "VALID_NOW");
  assert.ok(r.suggestedLot && r.suggestedLot > 0, "lot present");
  assert.ok(r.stopLoss && r.stopLoss > r.currentPrice!, "SELL stop above price");
  assert.ok(r.takeProfit.main && r.takeProfit.main < r.currentPrice!, "SELL TP below price");
  assert.ok(r.rewardToRisk && r.rewardToRisk > 0, "R:R computed");
  assert.ok(r.plainEnglishReason.length > 0);
  // No internal wording leaks.
  const copy = `${r.plainEnglishReason} ${r.noTradeReason ?? ""} ${r.riskWarning ?? ""}`;
  assert.doesNotMatch(copy, /scanner|endpoint|route|\btable\b|json|undefined/i);
});

test("SPREAD_TOO_WIDE: blocks when spread eats the stop", () => {
  const r = evaluateScalp(baseInput({ spec: v75Spec({ spreadPoints: 4000 }) }));
  assert.equal(r.status, "SPREAD_TOO_WIDE");
  assert.equal(r.canBuildTrade, false);
});

test("LATE: price already moved too far toward TP triggers chase warning", () => {
  // SELL entry 4605, TP 4580. Move price most of the way down to 4585.
  const r = evaluateScalp(baseInput({ currentPrice: 4585, scanner: sellScanner() }));
  assert.equal(r.status, "LATE");
  assert.equal(r.canBuildTrade, false);
  assert.ok(r.chaseWarning && /chase/i.test(r.chaseWarning), "chase warning present");
});

test("MARKET_CLOSED: closed market is never tradeable", () => {
  const r = evaluateScalp(baseInput({ spec: v75Spec({ marketOpen: false }) }));
  assert.equal(r.status, "MARKET_CLOSED");
  assert.equal(r.canBuildTrade, false);
});

test("SYMBOL_NOT_TRADEABLE: disabled trade mode blocks", () => {
  const r = evaluateScalp(baseInput({ spec: v75Spec({ tradeMode: "DISABLED" }) }));
  assert.equal(r.status, "SYMBOL_NOT_TRADEABLE");
  assert.equal(r.canBuildTrade, false);
});

test("AWAITING_DATA: non-live data source never used", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ dataSource: "SIMULATOR" }) }));
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.direction, null);
  assert.equal(r.canBuildTrade, false);
});

// ── ONE shared data-sufficiency authority (scanner ↔ scalp unification) ──────
test("AWAITING_DATA: LIVE_FEED but shared sufficiency verdict is insufficient", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ sufficiency: insufficientVerdict() }) }));
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.direction, null);
  assert.equal(r.canBuildTrade, false);
  // The engine surfaces the SHARED verdict's reason — same copy the scanner shows.
  assert.ok(
    r.noTradeReason && /closed candles/i.test(r.noTradeReason),
    `expected shared sufficiency reason, got: ${r.noTradeReason}`,
  );
});

test("AWAITING_DATA: LIVE_FEED but sufficiency verdict is MISSING (fail-closed)", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ sufficiency: null }) }));
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.direction, null);
  assert.equal(r.canBuildTrade, false);
});

test("sufficient shared verdict does NOT block: clean setup still READY", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ sufficiency: sufficientVerdict() }) }));
  assert.equal(r.status, "READY");
  assert.equal(r.direction, "SELL");
});

test("AWAITING_DATA (simulator, duplicate-guard shape kept)", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ dataSource: "SIMULATOR" }) }));
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.canBuildTrade, false);
  assert.equal(r.suggestedLot, null, "no fake lot on non-live data");
});

test("AWAITING_DATA: missing broker specs => no fake lot", () => {
  const r = evaluateScalp(baseInput({ spec: v75Spec({ hasBrokerTruth: false, tickValue: null, contractSize: null }) }));
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.suggestedLot, null);
});

test("lot respects min/max/step and is risk-bounded", () => {
  const r = evaluateScalp(baseInput({ riskAmount: 7 }));
  const lot = r.suggestedLot!;
  assert.ok(lot >= r.minLot! && lot <= r.maxLot!, "within min/max");
  // lot must be a multiple of step (within fp tolerance)
  const steps = lot / r.lotStep!;
  assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, "multiple of step");
  // estimated risk should not exceed budget (floored sizing)
  assert.ok(r.estimatedRiskAmount! <= 7 + 1e-6, "risk within budget");
});

test("tiny risk clamps up to min lot and flags it", () => {
  const r = evaluateScalp(baseInput({ riskAmount: 0.0001, targetProfitAmount: 0.0002 }));
  assert.equal(r.suggestedLot, r.minLot);
  assert.ok(r.noTradeReason && /minimum lot/i.test(r.noTradeReason));
});

test("BUY setup geometry: SL below entry, TP above", () => {
  const r = evaluateScalp(baseInput({ currentPrice: 4600, scanner: buyScanner() }));
  assert.equal(r.direction, "BUY");
  assert.ok(r.stopLoss! < r.currentPrice!, "BUY stop below price");
  assert.ok(r.takeProfit.main! > r.currentPrice!, "BUY TP above price");
});

test("WAIT_FOR_ENTRY: price outside zone yields a pending entry type", () => {
  // SELL, price well above the zone (needs to come down? for sell we wait for a bounce up into zone)
  const r = evaluateScalp(baseInput({ currentPrice: 4615, scanner: sellScanner() }));
  assert.ok(["WAIT_FOR_ENTRY", "LATE"].includes(r.status));
  if (r.status === "WAIT_FOR_ENTRY") {
    assert.ok(r.entryType && /LIMIT|STOP/.test(r.entryType));
    assert.equal(r.canBuildTrade, false);
    assert.equal(r.canWatch, true);
  }
});

test("NO_CLEAN_SCALP: scanner says wait/reject", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ recommendedAction: "REJECT" }) }));
  assert.equal(r.status, "NO_CLEAN_SCALP");
  assert.equal(r.canBuildTrade, false);
  assert.equal(r.canWatch, true);
});

test("NEWS_DANGER: high news risk blocks", () => {
  const r = evaluateScalp(baseInput({ scanner: sellScanner({ newsRisk: "HIGH" }) }));
  assert.equal(r.status, "NEWS_DANGER");
});

test("target reality check: realistic when projected profit covers target within risk", () => {
  const r = evaluateScalp(baseInput({ targetProfitAmount: 5, riskAmount: 20 }));
  assert.ok(["READY", "WAIT_FOR_ENTRY", "FORMING"].includes(r.status));
  assert.ok(["REALISTIC", "AGGRESSIVE_BUT_POSSIBLE"].includes(r.targetRealityCheck!), `got ${r.targetRealityCheck}`);
});

test("target reality check: too risky when target needs more than max lot", () => {
  // Tiny per-lot value via small contract; huge target.
  const r = evaluateScalp(baseInput({ targetProfitAmount: 100000, riskAmount: 100000, spec: v75Spec({ maxLot: 0.01 }) }));
  assert.ok(["TOO_RISKY", "NOT_AVAILABLE_RIGHT_NOW"].includes(r.targetRealityCheck!), `got ${r.targetRealityCheck}`);
});

test("INSUFFICIENT_MARGIN: free margin below estimated margin blocks", () => {
  // Large contract size + tiny free margin to force the margin gate.
  const r = evaluateScalp(
    baseInput({
      account: { balance: 1000, equity: 1000, freeMargin: 0.01, leverage: 1 },
      spec: v75Spec({ contractSize: 100000 }),
      riskAmount: 50,
    }),
  );
  assert.equal(r.status, "INSUFFICIENT_MARGIN");
  assert.equal(r.canBuildTrade, false);
});

test("mode changes the scalp type label", () => {
  const sniper = evaluateScalp(baseInput({ mode: "SNIPER" }));
  assert.equal(sniper.scalpType, "Sniper Scalp");
  const fast = evaluateScalp(baseInput({ mode: "FAST" }));
  assert.equal(fast.scalpType, "Fast Scalp");
});

test("expiresAt is in the future and validForSeconds > 0 for live setups", () => {
  const r = evaluateScalp(baseInput());
  assert.ok(r.validForSeconds > 0);
  assert.ok(new Date(r.expiresAt).getTime() > NOW);
});

// ── Ruby Flame Scalp — flame-read tests ───────────────────────────────────
//
// The flame read needs a live candle window. With no candles (every test
// above) the read is honest-BLIND and applies NO downgrade — that backward
// compatibility is asserted explicitly below. These tests drive specific
// candle shapes through the SAME engine to verify each flame stage and its
// downstream behaviour.

// A clean BUY input in-zone (dirSign = +1, so rising closes = the flame dir).
function buyInput(over: Partial<ScalpEngineInput> = {}): ScalpEngineInput {
  return baseInput({ currentPrice: 4600, scanner: buyScanner(), ...over });
}

/** A flat (no-momentum) candle at `p`: normal range, zero body (sets the ATR baseline). */
function flatCandle(p: number): ScalpCandle {
  return { open: p, high: p + 2, low: p - 2, close: p };
}
function flat(n: number, p: number): ScalpCandle[] {
  return Array.from({ length: n }, () => flatCandle(p));
}
/** A bullish candle from `open` to `close` (close > open) closing near its high. */
function bull(open: number, close: number, upWick = 0.1, loWick = 0.1): ScalpCandle {
  return { open, high: close + upWick, low: open - loWick, close };
}

test("flame BLIND: no candle window leaves status untouched and read honest-NONE", () => {
  const r = evaluateScalp(buyInput()); // no candles
  assert.ok(r.flame, "flame always present");
  assert.equal(r.flame.blind, true, "blind when no candles");
  assert.equal(r.flame.flameStage, "NONE", "no fabricated stage without candles");
  // Engine still produced its normal verdict — flame did not downgrade it.
  assert.equal(r.status, "READY");
});

test("flame IGNITING: fresh two-candle burst reads as early ignition", () => {
  const candles = [...flat(12, 4600), bull(4600, 4602), bull(4602, 4604)];
  const r = evaluateScalp(buyInput({ candles }));
  assert.equal(r.flame.blind, false);
  assert.equal(r.flame.flameStage, "IGNITING");
  assert.equal(r.flame.entryTiming, "EARLY");
  assert.equal(r.flame.chaseRisk, "LOW", "fresh burst is not a chase");
  assert.ok(["FRESH", "ACTIVE"].includes(r.flame.freshness));
  assert.ok(["CLEAR", "MODERATE"].includes(r.flame.runway), "room to target");
  assert.ok(r.flame.whyNow && r.flame.whyNow.length > 0, "plain-English why-now");
  assert.ok(["STRONG", "POSSIBLE"].includes(r.flame.scalpStatus));
});

test("flame ACTIVE: steady multi-candle push stays alive", () => {
  const candles = [
    ...flat(10, 4600),
    bull(4600, 4600.5),
    bull(4600.5, 4601),
    bull(4601, 4601.5),
  ];
  const r = evaluateScalp(buyInput({ candles }));
  assert.equal(r.flame.blind, false);
  assert.ok(["ACTIVE", "RUN_ON", "IGNITING"].includes(r.flame.flameStage), `got ${r.flame.flameStage}`);
  assert.ok(["FRESH", "ACTIVE"].includes(r.flame.freshness));
});

test("flame STRETCH: a long extended run is overextended (chase + going stale)", () => {
  const candles = [
    ...flat(6, 4600),
    bull(4600, 4604, 0.3, 0.3),
    bull(4604, 4609, 0.3, 0.3),
    bull(4609, 4614, 0.3, 0.3),
    bull(4614, 4619, 0.3, 0.3),
  ];
  const r = evaluateScalp(buyInput({ candles }));
  assert.equal(r.flame.flameStage, "STRETCH");
  assert.ok(["HIGH", "EXTREME"].includes(r.flame.chaseRisk), "stretched => chase risk");
  assert.equal(r.flame.freshness, "LATE");
  assert.ok(r.flame.decayNote && /stale|fading/i.test(r.flame.decayNote), "decay note present");
});

test("flame EXHAUSTED: climactic opposing wick kills the scalp (decay/expiry)", () => {
  const candles = [
    ...flat(4, 4600),
    bull(4600, 4604, 0.2, 0.2),
    bull(4604, 4609, 0.2, 0.2),
    bull(4609, 4615, 0.2, 0.2),
    bull(4615, 4622, 0.2, 0.2),
    // last: tiny body, huge upper (opposing) wick after the run
    { open: 4622, close: 4623, high: 4640, low: 4621.5 },
  ];
  const r = evaluateScalp(buyInput({ candles }));
  assert.equal(r.flame.flameStage, "EXHAUSTED");
  assert.equal(r.flame.freshness, "EXPIRED");
  assert.ok(r.flame.decayNote && r.flame.decayNote.length > 0, "expiry decay note");
  // Hard-dead flame downgrades the engine verdict and pulls trade numbers.
  assert.equal(r.status, "NO_CLEAN_SCALP");
  assert.equal(r.canBuildTrade, false);
});

test("flame FAILED: a burst that gave back past its origin is a hard no-scalp", () => {
  const candles = [
    ...flat(4, 4600),
    bull(4600, 4605, 0.2, 0.2), // strong push up
    { open: 4605, high: 4605.2, low: 4602, close: 4603 },
    { open: 4603, high: 4603.2, low: 4600, close: 4601 },
    { open: 4601, high: 4601.2, low: 4598, close: 4599 }, // back below origin
  ];
  const r = evaluateScalp(buyInput({ candles }));
  assert.equal(r.flame.flameStage, "FAILED");
  assert.equal(r.status, "NO_CLEAN_SCALP");
  assert.equal(r.canBuildTrade, false);
  assert.ok(r.flame.decayNote && /fail|gave back/i.test(r.flame.decayNote));
});

test("flame why-now reject: a flat window has no reason to enter", () => {
  const r = evaluateScalp(buyInput({ candles: flat(14, 4600) }));
  assert.equal(r.flame.flameStage, "NONE");
  assert.equal(r.flame.whyNow, null, "no fabricated reason");
  assert.equal(r.status, "NO_CLEAN_SCALP");
  assert.ok(r.noTradeReason && r.noTradeReason.length > 0, "plain-English no-trade reason");
});

test("flame one-stick block: a single ignition candle is held back to FORMING", () => {
  // age 1 ignition, BALANCED personality, no execution data (FAIR) => FORMING.
  const candles = [...flat(13, 4600), bull(4600, 4603)];
  const r = evaluateScalp(buyInput({ candles, riskPersonality: "BALANCED" }));
  assert.equal(r.flame.flameStage, "IGNITING");
  assert.equal(r.status, "FORMING", "one strong candle must confirm before entry");
  assert.equal(r.canBuildTrade, false);
});

test("flame execution-block: a stale bridge heartbeat blocks execution quality", () => {
  const candles = [...flat(12, 4600), bull(4600, 4602), bull(4602, 4604)];
  const r = evaluateScalp(
    buyInput({ candles, execution: { heartbeatAgeSeconds: 40, bridgeConnected: true } }),
  );
  assert.equal(r.flame.executionQuality, "BLOCKED", "heartbeat > 30s => blocked");
});

test("flame personality is threshold-only: same setup, stricter status under CONSERVATIVE", () => {
  const candles = [...flat(12, 4600), bull(4600, 4602), bull(4602, 4604)];
  const aggressive = evaluateScalp(buyInput({ candles, riskPersonality: "AGGRESSIVE" }));
  const conservative = evaluateScalp(buyInput({ candles, riskPersonality: "CONSERVATIVE" }));
  // Personality never weakens a safety gate — both still respect the same
  // tradeability rules; it only tunes how strict the flame verdict is.
  assert.equal(aggressive.flame.riskPersonality, "AGGRESSIVE");
  assert.equal(conservative.flame.riskPersonality, "CONSERVATIVE");
  // A stricter personality can only make the scalp-status the same or weaker.
  const order = { STRONG: 3, POSSIBLE: 2, WEAK: 1, NOT_A_SCALP: 0 } as const;
  assert.ok(order[conservative.flame.scalpStatus] <= order[aggressive.flame.scalpStatus]);
});

test("flame no fabrication: candles present but non-live data source stays blind", () => {
  const candles = [...flat(12, 4600), bull(4600, 4602), bull(4602, 4604)];
  const r = evaluateScalp(buyInput({ candles, scanner: buyScanner({ dataSource: "SIMULATOR" }) }));
  assert.equal(r.status, "AWAITING_DATA");
  assert.equal(r.flame.blind, true, "no live data => no flame read, even with candles");
  assert.equal(r.flame.flameStage, "NONE");
});
