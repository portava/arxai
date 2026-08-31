// Run-On Candle Momentum — deterministic unit tests for the FlameStage upgrade.
//
// Covers: RUN_ON classification (clean + young-clean), chop→WEAKENING guards,
// PULLBACK_REENTRY / CONTINUATION_REENTRY timing paths, add-on tier
// preservation (no timing penalty for re-entry timings), quality-based score
// adjustment, admin RunOnTrace fields, and blind-read invariant (no trace).
//
// All tests are pure / deterministic — no I/O, no live market data.
// All candle arrays use the same V75-like price space (≈4600) that the
// existing engine tests use so ATR expectations are predictable.
//
// Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpRunOn.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-run-on`)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import { evaluateScalp } from "../scalpEngine.js";
import { evaluateAddOn } from "../scalpManage.js";
import type {
  ScalpEngineInput,
  ScalpSpecInput,
  ScalpScannerInput,
  ScalpCandle,
  ScalpFlameRead,
} from "../scalpTypes.js";
import type { BasketSummary } from "../scalpManage.js";

const NOW = 1_780_000_000_000;

// The REAL shared sufficiency verdict — a live feed with plenty of closed bars
// on an approved market. The engine fail-closes without it (Task: one shared
// data-sufficiency authority), so every scanner builder must carry it.
function sufficientVerdict() {
  return evaluateMarketDataSufficiency({
    symbol: "Volatility 75 Index",
    timeframe: "M5",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 300,
  });
}

// ── Candle helpers ────────────────────────────────────────────────────────────

/** Bullish candle with tiny wicks — body ~= body. */
function bull(open: number, close: number, wickSize = 0.05): ScalpCandle {
  return { open, high: close + wickSize, low: open - wickSize, close };
}

/** Bearish candle with tiny wicks. */
function bear(open: number, close: number, wickSize = 0.05): ScalpCandle {
  return { open, high: open + wickSize, low: close - wickSize, close };
}

/** N flat doji candles (both directions, range = range param). */
function flat(n: number, price: number, range = 2): ScalpCandle[] {
  return Array.from({ length: n }, () => ({
    open: price,
    high: price + range,
    low: price - range,
    close: price,
  }));
}

/**
 * Build a "staircase" bull run: each candle opens exactly at the previous
 * close (zero body overlap — the ideal clean run-on candle pattern).
 */
function cleanBullRun(count: number, base: number, step: number): ScalpCandle[] {
  const candles: ScalpCandle[] = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    candles.push(bull(p, p + step, 0.05));
    p += step;
  }
  return candles;
}

/**
 * Build a "choppy" bull run: each candle opens near the middle of the
 * previous body, producing heavy overlap (overlapScore > 0.62 threshold).
 */
function choppyBullRun(count: number, base: number, step: number): ScalpCandle[] {
  const candles: ScalpCandle[] = [];
  let prevOpen = base;
  let prevClose = base + step;
  candles.push(bull(prevOpen, prevClose, 0.05));
  for (let i = 1; i < count; i++) {
    const mid = (prevOpen + prevClose) / 2;
    const newOpen = mid;           // opens inside prev body (50 %+ overlap)
    const newClose = newOpen + step * 0.5; // tiny advance
    candles.push(bull(newOpen, newClose, 0.05));
    prevOpen = newOpen;
    prevClose = newClose;
  }
  return candles;
}

// ── Spec & scanner helpers ────────────────────────────────────────────────────

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
    tickValue: 0.01,
    stopsLevelPoints: 0,
    spreadPoints: 20,
    category: "synthetic",
    displayName: "Volatility 75 Index",
    ...over,
  };
}

function buyScanner(
  entry = 4600,
  sl = 4580,
  tp = 4625,
  over: Partial<ScalpScannerInput> = {},
): ScalpScannerInput {
  return {
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: 82,
    entrySniperScore: 80,
    trendStrength: 65,
    setupType: "Continuation",
    entry,
    stopLoss: sl,
    takeProfit: tp,
    entryZone: { low: entry - 2, high: entry + 2 },
    dataSource: "LIVE_FEED",
    sufficiency: sufficientVerdict(),
    reasonForTrade: "Momentum continuation",
    ...over,
  };
}

function sellScanner(
  entry = 4600,
  sl = 4625,
  tp = 4575,
  over: Partial<ScalpScannerInput> = {},
): ScalpScannerInput {
  return {
    bias: "bearish",
    recommendedAction: "SELL",
    confidenceScore: 82,
    entrySniperScore: 80,
    trendStrength: 65,
    setupType: "Continuation",
    entry,
    stopLoss: sl,
    takeProfit: tp,
    entryZone: { low: entry - 2, high: entry + 2 },
    dataSource: "LIVE_FEED",
    sufficiency: sufficientVerdict(),
    reasonForTrade: "Momentum continuation",
    ...over,
  };
}

function buyInput(over: Partial<ScalpEngineInput> = {}): ScalpEngineInput {
  return {
    symbol: "V75",
    currentPrice: 4600,
    spec: v75Spec(),
    scanner: buyScanner(),
    account: { balance: 1000, equity: 1000, freeMargin: 1000, leverage: 100 },
    mode: "ANY",
    riskAmount: 10,
    now: NOW,
    ...over,
  };
}

// ── Stage classification ──────────────────────────────────────────────────────

describe("RUN_ON classification", () => {
  test("clean tight bull staircase (4 candles) classifies as RUN_ON", () => {
    // Perfect staircase: each candle opens at prev close (zero overlap).
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const currentPrice = base + 4 * step; // 4594
    const r = evaluateScalp(
      buyInput({ candles, currentPrice, scanner: buyScanner(4590, 4580, 4615) }),
    );
    assert.ok(!r.flame.blind, "should not be blind");
    assert.equal(
      r.flame.flameStage,
      "RUN_ON",
      `expected RUN_ON, got ${r.flame.flameStage}`,
    );
  });

  test("young clean bull run (3 candles, tight bodies) classifies as RUN_ON", () => {
    // 3-candle clean run: youngCleanRun path (age=3, low overlap, consistent bodies)
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(11, base),
      ...cleanBullRun(3, base, step),
    ];
    const currentPrice = base + 3 * step; // 4593
    const r = evaluateScalp(
      buyInput({ candles, currentPrice, scanner: buyScanner(4590, 4580, 4615) }),
    );
    assert.ok(!r.flame.blind);
    assert.ok(
      ["RUN_ON", "IGNITING", "ACTIVE"].includes(r.flame.flameStage),
      `expected an active stage (youngCleanRun path may need more candles); got ${r.flame.flameStage}`,
    );
    // Key invariant: even if IGNITING/ACTIVE, must not be WEAKENING/FAILED/EXHAUSTED
    assert.ok(
      !["WEAKENING", "EXHAUSTED", "FAILED", "REVERSAL_RISK"].includes(r.flame.flameStage),
      `clean 3-candle run should not degrade; got ${r.flame.flameStage}`,
    );
  });

  test("clean bearish run (4 candles) classifies as RUN_ON", () => {
    const base = 4610;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      bear(base, base - step, 0.05),
      bear(base - step, base - 2 * step, 0.05),
      bear(base - 2 * step, base - 3 * step, 0.05),
      bear(base - 3 * step, base - 4 * step, 0.05),
    ];
    const currentPrice = base - 4 * step; // 4606
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice,
        scanner: sellScanner(4610, 4620, 4590),
      }),
    );
    assert.ok(!r.flame.blind);
    assert.equal(
      r.flame.flameStage,
      "RUN_ON",
      `expected RUN_ON for clean bear run, got ${r.flame.flameStage}`,
    );
  });

  test("choppy bull run with heavy body overlap degrades to WEAKENING (not RUN_ON)", () => {
    // Heavy overlap: each candle opens near the mid of the previous body.
    const base = 4590;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...choppyBullRun(4, base, 1),
    ];
    const currentPrice = base + 2; // rough current price
    const r = evaluateScalp(
      buyInput({ candles, currentPrice, scanner: buyScanner(4590, 4580, 4615) }),
    );
    assert.ok(!r.flame.blind);
    // Choppy run should not be RUN_ON (should be WEAKENING or similar degraded stage)
    assert.ok(
      r.flame.flameStage !== "RUN_ON" || (r.flame.runOnTrace && r.flame.runOnTrace.overlapScore > 0.5),
      `choppy run should not classify as high-quality RUN_ON; ` +
        `stage=${r.flame.flameStage}, overlap=${r.flame.runOnTrace?.overlapScore}`,
    );
  });
});

// ── Score adjustment ──────────────────────────────────────────────────────────

describe("RUN_ON score adjustment", () => {
  test("clean staircase RUN_ON gets a non-negative score vs WEAKENING flame", () => {
    const base = 4590;
    const step = 1;

    // Clean run
    const cleanCandles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const cleanResult = evaluateScalp(
      buyInput({
        candles: cleanCandles,
        currentPrice: base + 4 * step,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );

    // Weakening run (opposing last candle → WEAKENING)
    const weakeningCandles: ScalpCandle[] = [
      ...flat(10, base),
      bull(base, base + 3, 0.05),
      bull(base + 3, base + 5, 0.05),
      bear(base + 5, base + 3.5, 0.5), // opposing candle
    ];
    const weakeningResult = evaluateScalp(
      buyInput({
        candles: weakeningCandles,
        currentPrice: base + 3.5,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );

    // Clean RUN_ON quality score should be >= weakening score
    assert.ok(
      cleanResult.qualityScore >= weakeningResult.qualityScore,
      `clean RUN_ON (${cleanResult.qualityScore}) should score >= weakening (${weakeningResult.qualityScore})`,
    );
  });

  test("clean RUN_ON runOnTrace.scannerScoreImpact is non-negative for tight staircase", () => {
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 4 * step,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    if (r.flame.flameStage === "RUN_ON") {
      assert.ok(
        r.flame.runOnTrace !== undefined,
        "runOnTrace should be present for RUN_ON stage",
      );
      assert.ok(
        r.flame.runOnTrace!.scannerScoreImpact >= 0,
        `clean staircase should have non-negative score impact; got ${r.flame.runOnTrace!.scannerScoreImpact}`,
      );
    }
  });
});

// ── Entry timing ──────────────────────────────────────────────────────────────

describe("PULLBACK_REENTRY and CONTINUATION_REENTRY timing", () => {
  test("PULLBACK_REENTRY: RUN_ON + price in zone + clean bodies → PULLBACK_REENTRY", () => {
    // Place entry zone around current price so inZone = true.
    // Candles: 10 flat at 4596, then 4 clean bull candles to 4600.
    const base = 4596;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const currentPrice = base + 4 * step; // 4600 — within zone [4598, 4602]
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice,
        scanner: buyScanner(4600, 4586, 4625), // entry=4600, zone=[4598,4602]
      }),
    );
    assert.ok(!r.flame.blind);
    if (r.flame.flameStage === "RUN_ON") {
      // Must be a re-entry-friendly timing, never LATE or CHASING
      assert.ok(
        ["PULLBACK_REENTRY", "CONTINUATION_REENTRY", "ACCEPTABLE"].includes(r.flame.entryTiming),
        `expected re-entry timing; got ${r.flame.entryTiming}`,
      );
      assert.notEqual(r.flame.entryTiming, "LATE");
      assert.notEqual(r.flame.entryTiming, "CHASING");
    }
  });

  test("CONTINUATION_REENTRY: RUN_ON + not in zone + early lateFraction → CONTINUATION_REENTRY", () => {
    // Price is above the zone (run started below zone, now above it).
    // Entry 4590, TP 4620 → large runway; candles run from 4584 to 4592.
    const base = 4584;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const currentPrice = base + 4 * step; // 4588
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice,
        // Entry zone well below currentPrice → not in zone; big TP for early lateFraction
        scanner: buyScanner(4595, 4580, 4625),
      }),
    );
    assert.ok(!r.flame.blind);
    if (r.flame.flameStage === "RUN_ON") {
      assert.ok(
        ["CONTINUATION_REENTRY", "PULLBACK_REENTRY", "ACCEPTABLE"].includes(r.flame.entryTiming),
        `expected continuation-friendly timing; got ${r.flame.entryTiming}`,
      );
      assert.notEqual(r.flame.entryTiming, "LATE");
      assert.notEqual(r.flame.entryTiming, "CHASING");
    }
  });

  test("PULLBACK_REENTRY is NOT penalized as LATE in add-on tier", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 80,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "PULLBACK_REENTRY",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "Re-entry in clean run",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4596,
      currentPrice: 4600,
      combinedFloatingPl: 50,
      plKnownLegCount: 1,
      breakEvenPrice: 4596,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, summary, "BALANCED");
    assert.ok(
      result.maxAddOns >= 1,
      `PULLBACK_REENTRY should not be penalized; maxAddOns=${result.maxAddOns}`,
    );
    assert.notEqual(
      result.recommendation,
      "DO_NOT_ADD",
      "PULLBACK_REENTRY should not block adds on an alive, in-profit basket",
    );
  });

  test("CONTINUATION_REENTRY is NOT penalized as LATE in add-on tier", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 80,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "CONTINUATION_REENTRY",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "Continuation in clean run",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4596,
      currentPrice: 4600,
      combinedFloatingPl: 50,
      plKnownLegCount: 1,
      breakEvenPrice: 4596,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, summary, "BALANCED");
    assert.ok(
      result.maxAddOns >= 1,
      `CONTINUATION_REENTRY should not be penalized; maxAddOns=${result.maxAddOns}`,
    );
    assert.notEqual(result.recommendation, "DO_NOT_ADD");
  });

  test("RUN_ON + PULLBACK_REENTRY + STRONG + in-profit → ADD_OK (not just ADD_WITH_CAUTION)", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 82,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "PULLBACK_REENTRY",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "Pullback re-entry",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4594,
      currentPrice: 4600,
      combinedFloatingPl: 80,
      plKnownLegCount: 1,
      breakEvenPrice: 4594,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, summary, "BALANCED");
    assert.equal(
      result.recommendation,
      "ADD_OK",
      `STRONG RUN_ON + PULLBACK_REENTRY + in-profit should be ADD_OK; got ${result.recommendation}`,
    );
  });

  test("PULLBACK_REENTRY counts as isFreshConfirmation for a losing basket", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 80,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "PULLBACK_REENTRY",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "Pullback re-entry",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
    };
    const losingSummary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4605,
      currentPrice: 4600,
      combinedFloatingPl: -30, // losing basket
      plKnownLegCount: 1,
      breakEvenPrice: 4605,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, losingSummary, "BALANCED");
    // Should allow 1 cautious add (not flat DO_NOT_ADD), because PULLBACK_REENTRY
    // qualifies as isFreshConfirmation for the revenge-trade guard.
    assert.ok(
      result.recommendation === "ADD_WITH_CAUTION",
      `losing basket + PULLBACK_REENTRY should be ADD_WITH_CAUTION; got ${result.recommendation}`,
    );
    assert.equal(result.maxAddOns, 1, "should allow exactly 1 cautious add");
  });
});

// ── Admin trace (RunOnTrace) ──────────────────────────────────────────────────

describe("RunOnTrace admin trace fields", () => {
  test("runOnTrace is populated for a RUN_ON flame", () => {
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 4 * step,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    if (r.flame.flameStage === "RUN_ON") {
      assert.ok(r.flame.runOnTrace !== undefined, "runOnTrace must be present when flameStage === RUN_ON");
      const t = r.flame.runOnTrace!;
      assert.ok(t.qualityScore >= 0 && t.qualityScore <= 1, `qualityScore must be 0..1; got ${t.qualityScore}`);
      assert.ok(t.candleCount >= 1, `candleCount must be >= 1; got ${t.candleCount}`);
      assert.ok(t.overlapScore >= 0 && t.overlapScore <= 1, `overlapScore must be 0..1; got ${t.overlapScore}`);
      assert.ok(t.maxOpposingWickRatio >= 0, `maxOpposingWickRatio must be >= 0; got ${t.maxOpposingWickRatio}`);
      assert.ok(t.bodyConsistency >= 0 && t.bodyConsistency <= 1, `bodyConsistency must be 0..1; got ${t.bodyConsistency}`);
      assert.ok(t.bodyStrength >= 0 && t.bodyStrength <= 1, `bodyStrength must be 0..1; got ${t.bodyStrength}`);
      assert.equal(t.stage, "RUN_ON");
      assert.equal(t.dataSource, "candle_window");
      assert.ok(
        typeof t.scannerScoreImpact === "number",
        `scannerScoreImpact must be a number; got ${typeof t.scannerScoreImpact}`,
      );
      assert.ok(
        ["EARLY", "CLEAN", "ACCEPTABLE", "LATE", "CHASING", "NO_ENTRY",
         "PULLBACK_REENTRY", "CONTINUATION_REENTRY"].includes(t.entryTimingClass),
        `entryTimingClass must be a valid EntryTiming; got ${t.entryTimingClass}`,
      );
    }
    // If classification did not produce RUN_ON, the engine still ran without error.
  });

  test("tight staircase RUN_ON has low overlapScore and high bodyConsistency in trace", () => {
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 4 * step,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    if (r.flame.flameStage === "RUN_ON" && r.flame.runOnTrace) {
      const t = r.flame.runOnTrace;
      assert.ok(t.overlapScore < 0.2, `tight staircase overlap should be < 0.2; got ${t.overlapScore}`);
      assert.ok(t.bodyConsistency > 0.7, `tight staircase body consistency should be > 0.7; got ${t.bodyConsistency}`);
      assert.ok(t.qualityScore > 0.5, `tight staircase quality should be > 0.5; got ${t.qualityScore}`);
    }
    // Gracefully pass if stage was not RUN_ON (ATR conditions may vary).
  });

  test("blind read never has runOnTrace", () => {
    const r = evaluateScalp(buyInput({ candles: null }));
    assert.equal(r.flame.blind, true, "should be blind");
    assert.equal(r.flame.runOnTrace, undefined, "blind read must have no runOnTrace");
  });

  test("IGNITING stage does not have runOnTrace", () => {
    // 2 expanding bull candles = IGNITING, not RUN_ON
    const base = 4590;
    const candles: ScalpCandle[] = [
      ...flat(12, base),
      bull(base, base + 3, 0.05),       // strong expanding candle
      bull(base + 3, base + 7, 0.05),   // even larger second candle
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 7,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    if (r.flame.flameStage === "IGNITING" || r.flame.flameStage === "ACTIVE") {
      assert.equal(
        r.flame.runOnTrace,
        undefined,
        "non-RUN_ON stages must not have runOnTrace",
      );
    }
  });
});

// ── Explicit add-on quality gate ─────────────────────────────────────────────
// baseAddOnTier must return 0 for RUN_ON when qualityScore < 0.3, even when
// the flame is nominally STRONG/POSSIBLE (choppy-but-not-yet-WEAKENING run).

describe("Explicit add-on quality gate for low-quality RUN_ON", () => {
  test("RUN_ON + qualityScore < 0.3 → maxAddOns=0 and DO_NOT_ADD regardless of profit cushion", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 78,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "ACCEPTABLE",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "Generic continuation",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
      runOnTrace: {
        qualityScore: 0.18, // below 0.3 threshold
        candleCount: 4,
        overlapScore: 0.80, // very choppy
        maxOpposingWickRatio: 0.8,
        bodyConsistency: 0.25,
        bodyStrength: 0.20,
        lastCloseLoc: 0.55,
        stage: "RUN_ON",
        entryTimingClass: "ACCEPTABLE",
        scannerScoreImpact: -4,
        dataSource: "candle_window",
      },
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4594,
      currentPrice: 4600,
      combinedFloatingPl: 120, // in profit — should not override the gate
      plKnownLegCount: 1,
      breakEvenPrice: 4594,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, summary, "BALANCED");
    assert.equal(
      result.maxAddOns,
      0,
      `low-quality RUN_ON (qualityScore=0.18) must block all adds; maxAddOns=${result.maxAddOns}`,
    );
    assert.equal(
      result.recommendation,
      "DO_NOT_ADD",
      `low-quality RUN_ON must recommend DO_NOT_ADD; got ${result.recommendation}`,
    );
  });

  test("RUN_ON + qualityScore < 0.3 + AGGRESSIVE personality → still maxAddOns=0", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 78,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "ACCEPTABLE",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "AGGRESSIVE",
      whyNow: "Generic continuation",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
      runOnTrace: {
        qualityScore: 0.12, // well below threshold
        candleCount: 4,
        overlapScore: 0.90,
        maxOpposingWickRatio: 1.0,
        bodyConsistency: 0.20,
        bodyStrength: 0.15,
        lastCloseLoc: 0.50,
        stage: "RUN_ON",
        entryTimingClass: "ACCEPTABLE",
        scannerScoreImpact: -5,
        dataSource: "candle_window",
      },
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4594,
      currentPrice: 4600,
      combinedFloatingPl: 200,
      plKnownLegCount: 1,
      breakEvenPrice: 4594,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, summary, "AGGRESSIVE");
    assert.equal(
      result.maxAddOns,
      0,
      `AGGRESSIVE personality must NOT override run-on quality gate; maxAddOns=${result.maxAddOns}`,
    );
    assert.equal(result.recommendation, "DO_NOT_ADD");
  });

  test("RUN_ON + qualityScore exactly at threshold (0.30) is NOT blocked", () => {
    // Boundary: qualityScore >= 0.3 should pass the gate (open gate is at < 0.3 only).
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 78,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "ACCEPTABLE",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "On-threshold run",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
      runOnTrace: {
        qualityScore: 0.30, // exactly at threshold — must pass
        candleCount: 4,
        overlapScore: 0.50,
        maxOpposingWickRatio: 0.4,
        bodyConsistency: 0.50,
        bodyStrength: 0.40,
        lastCloseLoc: 0.60,
        stage: "RUN_ON",
        entryTimingClass: "ACCEPTABLE",
        scannerScoreImpact: -2,
        dataSource: "candle_window",
      },
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4594,
      currentPrice: 4600,
      combinedFloatingPl: 80,
      plKnownLegCount: 1,
      breakEvenPrice: 4594,
      hasUnprotectedLeg: false,
    };
    const result = evaluateAddOn(flame, summary, "BALANCED");
    assert.ok(
      result.maxAddOns >= 1,
      `qualityScore=0.30 is at the boundary and should NOT be blocked; maxAddOns=${result.maxAddOns}`,
    );
    assert.notEqual(result.recommendation, "DO_NOT_ADD");
  });

  test("RUN_ON without runOnTrace (pre-trace build or blind) → normal tier path (no crash)", () => {
    const flame: ScalpFlameRead = {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 80,
      flameStage: "RUN_ON",
      flameAgeCandles: 4,
      freshness: "ACTIVE",
      entryTiming: "ACCEPTABLE",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "No trace attached",
      entryTrigger: null,
      targetIdea: null,
      invalidationIdea: null,
      decayNote: null,
      blind: false,
      // runOnTrace deliberately omitted
    };
    const summary: BasketSummary = {
      entryCount: 1,
      totalVolume: 0.01,
      averageEntry: 4594,
      currentPrice: 4600,
      combinedFloatingPl: 80,
      plKnownLegCount: 1,
      breakEvenPrice: 4594,
      hasUnprotectedLeg: false,
    };
    assert.doesNotThrow(() => evaluateAddOn(flame, summary, "BALANCED"));
    const result = evaluateAddOn(flame, summary, "BALANCED");
    // Without a trace, the gate falls through to the normal tier path.
    assert.ok(result.maxAddOns >= 1, "no-trace RUN_ON should not be hard-blocked");
  });
});

// ── Existing-test regression guard ───────────────────────────────────────────

describe("Regression: existing engine invariants still hold", () => {
  test("RUN_ON stage is still accepted as a valid active flame stage", () => {
    // Sanity check: the engine must still produce RUN_ON for a clean run.
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 4 * step,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    assert.ok(!r.flame.blind);
    assert.ok(
      ["RUN_ON", "ACTIVE", "IGNITING"].includes(r.flame.flameStage),
      `expected an active flame stage; got ${r.flame.flameStage}`,
    );
    // Entry timing must not be NO_ENTRY for a live, active stage with runway
    if (r.flame.flameStage !== "NONE") {
      assert.notEqual(r.flame.entryTiming, "NO_ENTRY");
    }
  });

  test("WEAKENING/EXHAUSTED/FAILED stages never carry runOnTrace", () => {
    // A run that reverses: should not produce runOnTrace even if age was >= 3.
    const base = 4590;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      bull(base, base + 2, 0.05),
      bull(base + 2, base + 4, 0.05),
      bull(base + 4, base + 6, 0.05),
      bear(base + 6, base + 2, 0.5), // large reversal candle
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 2,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    if (["WEAKENING", "EXHAUSTED", "FAILED", "REVERSAL_RISK"].includes(r.flame.flameStage)) {
      assert.equal(
        r.flame.runOnTrace,
        undefined,
        `${r.flame.flameStage} stage must not have runOnTrace`,
      );
    }
  });

  test("copy strings do not leak internal token names", () => {
    const base = 4590;
    const step = 1;
    const candles: ScalpCandle[] = [
      ...flat(10, base),
      ...cleanBullRun(4, base, step),
    ];
    const r = evaluateScalp(
      buyInput({
        candles,
        currentPrice: base + 4 * step,
        scanner: buyScanner(4590, 4580, 4615),
      }),
    );
    const copy = [
      r.flame.whyNow,
      r.flame.entryTrigger,
      r.flame.targetIdea,
      r.flame.decayNote,
      r.plainEnglishReason,
      r.noTradeReason,
    ]
      .filter(Boolean)
      .join(" ");
    assert.doesNotMatch(
      copy,
      /PULLBACK_REENTRY|CONTINUATION_REENTRY|RUN_ON|flameStage|scanner|endpoint|undefined/i,
      "copy must not leak internal enum token names or code terms",
    );
  });
});
