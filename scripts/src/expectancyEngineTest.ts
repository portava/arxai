// Test: expectancy pure core + honest scanner scoring + strategy honesty label
// (R7 step 5 core + step 7 — intel-engine.md §1.1/§1.3/§2 #18).
//
// What this suite pins, and why each pin exists:
//
//   1. WILSON MATH. pWin.lower95 is the lower endpoint of the Wilson score
//      interval at two-sided 95% (Wilson 1927) — pinned against an independent
//      inline implementation AND textbook constants (1/1 ≈ 0.2065,
//      50/100 ≈ 0.4038), with the structural properties that make it the
//      honest choice: 0 wins ⇒ bound 0, bound never exceeds the sample
//      proportion, monotone in wins, tightens with n.
//
//   2. EV VERDICT MATRIX. conservativeEv = lower95·targetR − (1−lower95)·1 −
//      costs.totalR. POSITIVE only when the sample floor passes AND the
//      cost-inclusive lower-bound EV is > 0; EV <= 0 ⇒ WAIT; fewer than 30
//      outcomes ⇒ INSUFFICIENT_SAMPLE no matter how good the numbers look
//      (never extrapolate). Realized rMultiples are recorded but must NOT
//      move the conservative EV (declared geometry only).
//
//   3. COSTS REQUIRED. Missing / non-finite / negative cost inputs are a
//      typed refusal (CostInputsRequiredError), never a flattering zero
//      default; a smuggled totalR that disagrees with its components refuses.
//
//   4. SCANNER FACTOR PINS. opportunityScore no longer double-counts
//      entryQualityScore (supportResistanceQuality pinned 0), never derives
//      spreadCondition from riskScore (actual quote spread or the neutral
//      constant), pins aiConfidenceCalibration to the neutral constant (no
//      calibration exists yet), and is DOWNGRADE-ONLY vs the pre-R7 formula
//      for every input in a broad grid.
//
//   5. STRATEGY HONESTY LABEL. Every strategy-engine payload — actionable or
//      WAIT, from runStrategyScan or any individual strategy — carries
//      advisory: "ADVISORY_UNCALIBRATED"; the folded constant terms did not
//      change reachable outputs (BOS confidence stays in {70, 80}); the BOS
//      stop geometry is unchanged (stop at the opposite 17-bar extreme — the
//      audit-mandated constraint note is comment-only).
//
// Offline by construction: DATABASE_URL is pointed at the dummy unroutable
// loopback (emergencyKillSwitchPreGate.test.ts pattern) BEFORE the api-server
// module graph is dynamically imported; no query is ever issued.
//
// Run: pnpm --filter @workspace/scripts exec tsx src/expectancyEngineTest.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { expectancy } from "@workspace/domain";
import type { MarketAnalysis } from "../../artifacts/api-server/src/lib/aiBrain.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const {
  wilsonLower95,
  estimateOutcome,
  computeCostsR,
  CostInputsRequiredError,
  ExpectancyInputError,
  MIN_DECISION_SAMPLE,
  WILSON_Z_95,
} = expectancy;
type CostInputs = ReturnType<typeof computeCostsR>;
type OutcomeSample = { won: boolean; rMultiple: number | null };

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }

  function throws<E>(fn: () => unknown, ctor: new (...a: never[]) => E, label: string) {
    try {
      fn();
      assert(false, `${label} (did not throw)`);
    } catch (err) {
      assert(err instanceof ctor, `${label} (threw ${err instanceof Error ? err.name : typeof err})`);
    }
  }

  console.log("expectancyEngineTest");
  console.log("====================\n");

  // Independent Wilson reimplementation — same published formula, written
  // separately so a transcription bug in the engine cannot self-certify.
  function wilsonRef(wins: number, n: number): number {
    if (n === 0) return 0;
    const z = WILSON_Z_95;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (centre - margin) / denom);
  }

  // ── 1. Wilson lower bound math ─────────────────────────────────────────────
  console.log("Wilson lower bound (two-sided 95%, Wilson 1927)");
  {
    assert(Math.abs(wilsonLower95(0, 50)) < 1e-12, "0 wins out of 50 bounds at exactly 0 (no evidence claims nothing)");
    assert(Math.abs(wilsonLower95(1, 1) - 0.2065) < 1e-3, `1/1 ≈ 0.2065 textbook value (got ${wilsonLower95(1, 1).toFixed(6)})`);
    assert(Math.abs(wilsonLower95(50, 100) - 0.4038) < 1e-3, `50/100 ≈ 0.4038 textbook value (got ${wilsonLower95(50, 100).toFixed(6)})`);

    let refMismatch = 0;
    let abovePoint = 0;
    let outOfRange = 0;
    for (const n of [1, 5, 29, 30, 100, 1000]) {
      for (const wins of [0, 1, Math.floor(n / 2), n - 1, n].filter((w) => w >= 0 && w <= n)) {
        const got = wilsonLower95(wins, n);
        if (Math.abs(got - wilsonRef(wins, n)) > 1e-12) refMismatch++;
        if (got > wins / n + 1e-12) abovePoint++;
        if (got < 0 || got > 1) outOfRange++;
      }
    }
    assert(refMismatch === 0, `matches the independent implementation across the grid (${refMismatch} mismatches)`);
    assert(abovePoint === 0, "never exceeds the sample proportion (conservative by construction)");
    assert(outOfRange === 0, "always inside [0, 1] (the Wald approximation fails this; Wilson must not)");
    assert(wilsonLower95(60, 100) > wilsonLower95(50, 100), "monotone in wins at fixed n");
    assert(wilsonLower95(500, 1000) > wilsonLower95(50, 100), "same proportion, larger sample ⇒ tighter (higher) bound");

    throws(() => wilsonLower95(5, 4), ExpectancyInputError, "wins > n refuses (typed)");
    throws(() => wilsonLower95(-1, 4), ExpectancyInputError, "negative wins refuses (typed)");
    throws(() => wilsonLower95(1.5, 4), ExpectancyInputError, "non-integer wins refuses (typed)");
  }

  // ── 2. Conservative-EV verdict matrix ──────────────────────────────────────
  console.log("\nConservative-EV verdict matrix");
  {
    const mkSamples = (wins: number, losses: number, winR = 2, lossR = -1): OutcomeSample[] => [
      ...Array.from({ length: wins }, () => ({ won: true, rMultiple: winR })),
      ...Array.from({ length: losses }, () => ({ won: false, rMultiple: lossR })),
    ];
    // Explicit costs: 1R = 10 price units; spread 0.5 + commission 0.3 + slippage 0.2 ⇒ totalR 0.10.
    const costs = computeCostsR({ stopDistancePrice: 10, spreadPrice: 0.5, commissionPrice: 0.3, slippagePrice: 0.2 });
    assert(Math.abs(costs.totalR - 0.1) < 1e-12, `cost model converts price units to R (totalR ${costs.totalR})`);

    const positive = estimateOutcome({ samples: mkSamples(70, 30), targetR: 2, costs });
    const lb70 = wilsonRef(70, 100);
    assert(positive.sampleSize === 100 && Math.abs(positive.pWin.point - 0.7) < 1e-12, "point estimate is wins/n");
    assert(Math.abs(positive.pWin.lower95 - lb70) < 1e-12, "lower95 is the Wilson bound");
    assert(
      Math.abs(positive.conservativeEv - (lb70 * 2 - (1 - lb70) - 0.1)) < 1e-12,
      `conservativeEv = lower95·targetR − (1−lower95) − costs.totalR (got ${positive.conservativeEv.toFixed(6)})`,
    );
    assert(positive.verdict === "POSITIVE", "70/100 at 2R with 0.1R costs ⇒ POSITIVE");

    const wait = estimateOutcome({ samples: mkSamples(50, 50), targetR: 1, costs });
    assert(wait.conservativeEv < 0 && wait.verdict === "WAIT", "50/100 at 1R ⇒ EV lower bound < 0 ⇒ WAIT");

    // EV exactly 0 is WAIT, not POSITIVE (<= 0 rule).
    const lb60 = wilsonRef(60, 100);
    const evZeroCost = lb60 * 2 - (1 - lb60);
    const zeroCosts: CostInputs = { spreadR: evZeroCost, commissionR: 0, slippageR: 0, totalR: evZeroCost };
    const boundary = estimateOutcome({ samples: mkSamples(60, 40), targetR: 2, costs: zeroCosts });
    assert(boundary.conservativeEv === 0 && boundary.verdict === "WAIT", "conservativeEv exactly 0 ⇒ WAIT (never POSITIVE)");

    // The sample floor outranks a positive EV — never extrapolate.
    assert(MIN_DECISION_SAMPLE === 30, "decision floor is 30 recorded outcomes");
    const thin = estimateOutcome({ samples: mkSamples(25, 4), targetR: 2, costs });
    assert(thin.sampleSize === 29 && thin.conservativeEv > 0, "29-sample fixture would otherwise look POSITIVE");
    assert(thin.verdict === "INSUFFICIENT_SAMPLE", "29 samples ⇒ INSUFFICIENT_SAMPLE even with positive EV");
    const atFloor = estimateOutcome({ samples: mkSamples(26, 4), targetR: 2, costs });
    assert(atFloor.sampleSize === 30 && atFloor.verdict === "POSITIVE", "exactly 30 samples with positive EV ⇒ POSITIVE");

    const empty = estimateOutcome({ samples: [], targetR: 2, costs });
    assert(
      empty.verdict === "INSUFFICIENT_SAMPLE" && empty.pWin.point === 0 && empty.pWin.lower95 === 0,
      "zero samples ⇒ INSUFFICIENT_SAMPLE with pWin 0/0 (nothing claimed)",
    );
    assert(Math.abs(empty.conservativeEv - (-1 - 0.1)) < 1e-12, "zero-sample EV is −1 − costs (honest arithmetic, not decision-grade)");

    // Declared geometry only: realized rMultiples must not move the EV.
    const flat = estimateOutcome({ samples: mkSamples(70, 30, 2, -1), targetR: 2, costs });
    const wild = estimateOutcome({ samples: mkSamples(70, 30, 9.5, -0.1), targetR: 2, costs });
    assert(flat.conservativeEv === wild.conservativeEv, "realized rMultiples are recorded, never averaged into the conservative EV");
    const withNulls = estimateOutcome({
      samples: [...mkSamples(70, 30).map((s) => ({ ...s, rMultiple: null }))],
      targetR: 2,
      costs,
    });
    assert(withNulls.conservativeEv === flat.conservativeEv, "rMultiple null (honest unknown) is accepted");

    throws(
      () => estimateOutcome({ samples: [{ won: true, rMultiple: Number.NaN }], targetR: 2, costs }),
      ExpectancyInputError,
      "NaN rMultiple refuses (typed)",
    );
    throws(
      () => estimateOutcome({ samples: [{ won: 1 as unknown as boolean, rMultiple: null }], targetR: 2, costs }),
      ExpectancyInputError,
      "non-boolean won refuses (typed)",
    );
    throws(() => estimateOutcome({ samples: [], targetR: 0, costs }), ExpectancyInputError, "targetR 0 refuses (typed)");
    throws(() => estimateOutcome({ samples: [], targetR: -2, costs }), ExpectancyInputError, "negative targetR refuses (typed)");
  }

  // ── 3. Costs are REQUIRED (typed refusal, no flattering defaults) ──────────
  console.log("\nCost-model refusal (costs REQUIRED)");
  {
    throws(
      () => estimateOutcome({ samples: [], targetR: 2, costs: undefined as unknown as CostInputs }),
      CostInputsRequiredError,
      "estimateOutcome without costs refuses",
    );
    try {
      computeCostsR({ stopDistancePrice: 10, commissionPrice: 0, slippagePrice: 0 } as Parameters<typeof computeCostsR>[0]);
      assert(false, "missing spreadPrice refuses");
    } catch (err) {
      assert(
        err instanceof CostInputsRequiredError && err.field === "spreadPrice",
        `missing spreadPrice refuses with the field named (got ${err instanceof CostInputsRequiredError ? err.field : "?"})`,
      );
    }
    throws(
      () => computeCostsR({ stopDistancePrice: 10, spreadPrice: 0.5, commissionPrice: 0.3, slippagePrice: Number.NaN }),
      CostInputsRequiredError,
      "NaN slippage refuses (never coerced to 0)",
    );
    throws(
      () => computeCostsR({ stopDistancePrice: 10, spreadPrice: 0.5, commissionPrice: -0.3, slippagePrice: 0 }),
      CostInputsRequiredError,
      "negative commission refuses",
    );
    throws(
      () => computeCostsR({ stopDistancePrice: 0, spreadPrice: 0.5, commissionPrice: 0.3, slippagePrice: 0.2 }),
      CostInputsRequiredError,
      "stopDistancePrice 0 refuses (1R undefined ⇒ no R-unit costs)",
    );
    throws(
      () =>
        estimateOutcome({
          samples: [],
          targetR: 2,
          costs: { spreadR: 0.5, commissionR: 0.3, slippageR: 0.2, totalR: 0.1 },
        }),
      CostInputsRequiredError,
      "smuggled totalR that disagrees with its components refuses",
    );
  }

  // ── 4. Scanner factor pins (honest opportunityScore consumption) ───────────
  console.log("\nScanner factor pins (marketScanner.opportunityScore)");
  const scanner = await import("../../artifacts/api-server/src/lib/marketScanner.js");
  {
    const { opportunityScore, NEUTRAL_SPREAD_FACTOR, NEUTRAL_CALIBRATION_FACTOR } = scanner;

    function mkAnalysis(over: Partial<MarketAnalysis> = {}): MarketAnalysis {
      return {
        dataAvailable: true,
        unavailableReason: null,
        symbol: "EURUSD",
        timeframe: "M5",
        marketBias: "bullish",
        trendStrength: 50,
        setupQualityScore: 50,
        entryQualityScore: 50,
        riskScore: 50,
        confidenceScore: 50,
        recommendedAction: "BUY",
        entryZone: { low: 99, high: 101 }, // entry midpoint 100
        stopLoss: 95, // stop distance 5 price units
        takeProfit: 110,
        riskRewardRatio: 2,
        reasonForTrade: "test",
        reasonToAvoid: "",
        invalidationReason: "",
        rulesPassed: [],
        rulesFailed: [],
        dataSource: "LIVE_FEED",
        executionEnvironment: "LIVE_FEED",
        generatedAt: "2026-08-20T00:00:00.000Z",
        ...over,
      };
    }

    // The exact pre-R7 formula (double-count + proxies) — the doctrine baseline.
    function legacyScore(a: MarketAnalysis, stratMatch = 7): number {
      const cl = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);
      const trend = cl(Math.round((a.trendStrength / 100) * 15), 0, 15);
      const eq = cl(Math.round((a.entryQualityScore / 100) * 15), 0, 15);
      const rr = cl(Math.round(Math.min(a.riskRewardRatio / 3, 1) * 15), 0, 15);
      const vol = a.marketBias === "choppy" ? 2 : 8;
      const spread = cl(10 - Math.round((a.riskScore / 100) * 10), 0, 10);
      const calib = cl(Math.round((a.confidenceScore / 100) * 10), 0, 10);
      return trend + eq * 2 + rr + vol + spread + cl(Math.round(stratMatch), 0, 10) + calib;
    }

    // No double count: the duplicate S/R alias is pinned 0; entry quality flows ONCE.
    const eqHigh = opportunityScore(mkAnalysis({ entryQualityScore: 100 }));
    const eqLow = opportunityScore(mkAnalysis({ entryQualityScore: 0 }));
    assert(eqHigh.factors.supportResistanceQuality === 0, "supportResistanceQuality pinned to 0 (duplicate factor dropped)");
    assert(eqHigh.factors.entryTiming === 15 && eqLow.factors.entryTiming === 0, "entryTiming carries entryQualityScore once (0..15)");
    assert(eqHigh.score - eqLow.score <= 15, `entry quality moves the total by at most 15, not 30 (delta ${eqHigh.score - eqLow.score})`);

    // Spread is never riskScore-derived.
    const riskLow = opportunityScore(mkAnalysis({ riskScore: 0 }));
    const riskHigh = opportunityScore(mkAnalysis({ riskScore: 100 }));
    assert(
      riskLow.factors.spreadCondition === NEUTRAL_SPREAD_FACTOR && riskHigh.factors.spreadCondition === NEUTRAL_SPREAD_FACTOR,
      "no quote spread ⇒ neutral spread factor regardless of riskScore",
    );
    const tight = opportunityScore(mkAnalysis({ riskScore: 100 }), 7, { spreadPrice: 0.05 }); // ratio 0.01 of stop
    const half = opportunityScore(mkAnalysis({ riskScore: 0 }), 7, { spreadPrice: 1.25 }); // ratio 0.25
    const wide = opportunityScore(mkAnalysis({ riskScore: 0 }), 7, { spreadPrice: 2.5 }); // ratio 0.50
    assert(tight.factors.spreadCondition === 10, `tight actual spread scores 10 even at riskScore 100 (got ${tight.factors.spreadCondition})`);
    assert(half.factors.spreadCondition === 5, `spread at 25% of stop scores 5 (got ${half.factors.spreadCondition})`);
    assert(wide.factors.spreadCondition === 0, `spread at 50% of stop scores 0 even at riskScore 0 (got ${wide.factors.spreadCondition})`);
    const sameSpreadDifferentRisk = opportunityScore(mkAnalysis({ riskScore: 100 }), 7, { spreadPrice: 1.25 });
    assert(
      sameSpreadDifferentRisk.factors.spreadCondition === half.factors.spreadCondition,
      "identical actual spread ⇒ identical spread factor across riskScore 0 vs 100",
    );

    // Calibration is a neutral constant until real calibration data exists.
    const confLow = opportunityScore(mkAnalysis({ confidenceScore: 0 }));
    const confHigh = opportunityScore(mkAnalysis({ confidenceScore: 100 }));
    assert(
      confLow.factors.aiConfidenceCalibration === NEUTRAL_CALIBRATION_FACTOR &&
        confHigh.factors.aiConfidenceCalibration === NEUTRAL_CALIBRATION_FACTOR,
      "aiConfidenceCalibration is the neutral constant for confidence 0 and 100 alike",
    );

    // Flagship concrete pin (default strategyMatch 7): the old formula's best
    // case scored 95 = 15 + 15·2 (double-count) + 15 + 8 + 10 (risk proxy) + 7
    // + 10 (confidence proxy); the honest formula scores 70 = 15 + 0 + 15 + 15
    // + 8 + 5 (neutral spread) + 7 + 5 (neutral calibration) for the SAME input.
    const flagship = mkAnalysis({ trendStrength: 100, entryQualityScore: 100, confidenceScore: 100, riskScore: 0, riskRewardRatio: 3 });
    assert(legacyScore(flagship) === 95, `pre-R7 formula reproduced (baseline sanity, got ${legacyScore(flagship)})`);
    assert(opportunityScore(flagship).score === 70, `honest score for the old 95-case is 70 (got ${opportunityScore(flagship).score})`);

    // Downgrade-only doctrine: no input may score HIGHER than the pre-R7 formula.
    let violations = 0;
    let checked = 0;
    for (const trendStrength of [0, 50, 100])
      for (const entryQualityScore of [0, 50, 100])
        for (const confidenceScore of [0, 50, 100])
          for (const riskScore of [0, 50, 100])
            for (const riskRewardRatio of [0, 2, 3.5])
              for (const marketBias of ["bullish", "choppy"] as const)
                for (const spread of [undefined, { spreadPrice: 0.05 }, { spreadPrice: 1.25 }, { spreadPrice: 2.5 }]) {
                  const a = mkAnalysis({ trendStrength, entryQualityScore, confidenceScore, riskScore, riskRewardRatio, marketBias });
                  checked++;
                  if (opportunityScore(a, 7, spread).score > legacyScore(a)) violations++;
                }
    assert(violations === 0, `downgrade-only vs the pre-R7 formula across ${checked} input combos (${violations} violations)`);
  }

  // ── 5. Strategy honesty label + behavior-preserving folds ──────────────────
  console.log("\nStrategy honesty (ADVISORY_UNCALIBRATED label + folds)");
  const engine = await import("../../artifacts/api-server/src/lib/strategyEngine.js");
  {
    const {
      runStrategyScan,
      trendContinuationStrategy,
      breakOfStructureStrategy,
      liquiditySweepStrategy,
      volatilityExpansionStrategy,
      pullbackContinuationStrategy,
      meanReversionStrategy,
      sessionBreakoutStrategy,
      STRATEGY_ADVISORY_LABEL,
    } = engine;
    type EngineCandle = Parameters<typeof runStrategyScan>[1][number];

    assert(STRATEGY_ADVISORY_LABEL === "ADVISORY_UNCALIBRATED", "label literal is ADVISORY_UNCALIBRATED");

    const mkCandle = (i: number, o: number, h: number, l: number, c: number): EngineCandle => ({
      time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: 100,
    });

    // Insufficient-data WAIT payloads must carry the label from every strategy.
    const shortCandles = [mkCandle(0, 100, 101, 99, 100), mkCandle(1, 100, 101, 99, 100), mkCandle(2, 100, 101, 99, 100)];
    const strategies: Array<[string, (c: EngineCandle[], s: string) => { advisory?: string; direction: string }]> = [
      ["trendContinuation", trendContinuationStrategy],
      ["breakOfStructure", breakOfStructureStrategy],
      ["liquiditySweep", liquiditySweepStrategy],
      ["volatilityExpansion", volatilityExpansionStrategy],
      ["pullbackContinuation", pullbackContinuationStrategy],
      ["meanReversion", meanReversionStrategy],
      ["sessionBreakout", sessionBreakoutStrategy],
    ];
    for (const [name, fn] of strategies) {
      const out = fn(shortCandles, "EURUSD");
      assert(out.advisory === STRATEGY_ADVISORY_LABEL, `${name} WAIT payload carries the advisory label`);
    }
    const scanShort = runStrategyScan("EURUSD", shortCandles);
    assert(scanShort.advisory === STRATEGY_ADVISORY_LABEL && scanShort.direction === "WAIT", "runStrategyScan insufficient-data payload carries the label");

    // Crafted BOS BUY: 17 quiet bars, a poke above the swing high, a red pullback bar.
    const bos: EngineCandle[] = [];
    for (let i = 0; i < 17; i++) {
      const c = 100 - i * 0.05;
      bos.push(mkCandle(i, c + 0.05, c + 0.5, c - 0.5, c));
    }
    bos.push(mkCandle(17, 99.1, 99.9, 98.9, 99.3));
    bos.push(mkCandle(18, 99.3, 105, 99.0, 100.4)); // prev candle: breaks the 100.5 swing high
    bos.push(mkCandle(19, 100.4, 100.6, 99.5, 99.8)); // last candle: red pullback
    const bosOut = breakOfStructureStrategy(bos, "EURUSD");
    const recent = bos.slice(-20);
    const swingLow = Math.min(...recent.slice(0, -3).map((c) => c.low));
    assert(bosOut.direction === "BUY", `crafted structure break fires BUY (got ${bosOut.direction}: ${bosOut.reason})`);
    assert(bosOut.advisory === STRATEGY_ADVISORY_LABEL, "actionable BOS payload carries the advisory label");
    assert(
      bosOut.confidence === 70 || bosOut.confidence === 80,
      `folded constants preserved reachable outputs — confidence in {70, 80} (got ${bosOut.confidence})`,
    );
    assert(bosOut.stopLoss === swingLow, "BOS stop geometry unchanged (opposite 17-bar extreme; the honesty note is comment-only)");

    // Winner-take-all + filters must preserve the label on the final payload.
    const scanBos = runStrategyScan("EURUSD", bos, 0);
    assert(scanBos.advisory === STRATEGY_ADVISORY_LABEL, "runStrategyScan winning payload carries the label");
    const scanFiltered = runStrategyScan("EURUSD", bos, 99);
    assert(
      scanFiltered.advisory === STRATEGY_ADVISORY_LABEL && scanFiltered.direction === "WAIT",
      "filter-degraded WAIT payload still carries the label",
    );
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "expectancyEngineTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[expectancyEngineTest] FAILED:", err);
      process.exit(1);
    },
  );
}
