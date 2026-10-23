// Test: the null-calibrated validation factory (@workspace/validation).
//
// THE KILLER TEST IS SECTION 5, AND IT IS THE POINT OF THE WHOLE PACKAGE.
//
// Deriv's "Volatility N" instruments are generated as driftless geometric
// Brownian motion. A directional edge on them is not unlikely — it is impossible
// by construction. So the entire discovery search (all seven strategyEngine
// families, every parameter in the grid) is run over honest V75 and the factory
// must certify ZERO edges. Any survivor means the factory certifies noise, and
// a factory that certifies noise will certify noise on real markets too, where
// nobody can tell.
//
// That test must be ABLE to fail. It is not a formality: it is the only place in
// this codebase where the right answer is known in advance, which makes it the
// only place the machinery can actually be calibrated rather than merely
// exercised.
//
// The other sections check each estimator against a situation with a known
// answer:
//   7a  honest V75 certifies as null; a drift-injected feature path is DETECTED
//   7b  a planted 5-bar label overlap inflates Sharpe, and purging collapses it
//   7c  the max of 500 null Sharpes deflates to non-significant ≥95% of the time
//   7d  a pure-noise ensemble gives PBO ≈ 0.5 (selection carries no information)
//
// All randomness is SEEDED. A calibration that cannot be reproduced from its
// seed has no standing to judge anyone else's reproducibility.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import {
  certifyNull,
  logReturns,
  generateSyntheticNullSeries,
  generateSyntheticNullBars,
  cpcvSplits,
  minTrainTestGap,
  deflatedSharpe,
  expectedMaxSharpe,
  estimatePbo,
  validateFamily,
  allStrategyVariants,
  barsFromCloses,
  strategyReturns,
  FAMILY_KEYS,
  sharpe,
  stdev,
  skewness,
  kurtosis,
  seeded,
  gaussian,
  normalCdf,
  normalInv,
  ksTestNormal,
  type TrialResult,
} from "@workspace/validation";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

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
  function near(a: number, b: number, tol: number, label: string) {
    assert(Number.isFinite(a) && Math.abs(a - b) <= tol, `${label} (got ${a}, expected ${b} ±${tol})`);
  }

  console.log("validationFactoryTest");
  console.log("=====================\n");

  // ── 0. The statistics themselves ───────────────────────────────────────────
  console.log("Statistical primitives");
  {
    near(normalCdf(0), 0.5, 1e-7, "Φ(0) = 0.5");
    near(normalCdf(1.959963985), 0.975, 1e-6, "Φ(1.96) = 0.975");
    near(normalCdf(-1.959963985), 0.025, 1e-6, "Φ(−1.96) = 0.025");
    near(normalInv(0.975), 1.959963985, 1e-6, "Φ⁻¹(0.975) = 1.96");
    near(normalInv(0.5), 0, 1e-9, "Φ⁻¹(0.5) = 0");
    // Round trip, the check that catches a wrong-tail approximation.
    for (const p of [0.01, 0.1, 0.3, 0.7, 0.9, 0.99]) {
      near(normalCdf(normalInv(p)), p, 1e-6, `Φ(Φ⁻¹(${p})) round-trips`);
    }
    const g = gaussian(seeded(1));
    const draws = Array.from({ length: 20000 }, g);
    near(ksTestNormal(draws).p > 0.05 ? 1 : 0, 1, 0, "20k seeded gaussian draws pass a KS test");
    near(stdev(draws), 1, 0.03, "…with unit standard deviation");
    near(skewness(draws), 0, 0.06, "…zero skew");
    near(kurtosis(draws), 3, 0.15, "…and kurtosis ≈ 3");
    // The generator is seeded, so the whole suite is reproducible.
    assert(
      gaussian(seeded(1))() === gaussian(seeded(1))(),
      "the PRNG is seeded and reproducible (never Math.random)",
    );
  }

  // ── 7a. SyntheticNullOracle ────────────────────────────────────────────────
  console.log("\n7a SyntheticNullOracle — the substrate really is null");
  {
    const honest = generateSyntheticNullSeries({ volIndex: 75, bars: 20000, seed: 42 });
    const cert = certifyNull(75, honest);
    assert(cert.ok, `honest V75 certifies as null — ${cert.detail}`);
    assert(cert.ksP > 0.05, `…KS p = ${cert.ksP.toFixed(4)} > 0.05 (shape is N(0,1))`);
    assert(!cert.meanCiExcludesZero, "…and the mean CI CONTAINS zero (no drift)");
    near(cert.standardisedSd, 1, 0.05, "standardising by the CLOSED-FORM σ gives unit variance");

    // A drift-injecting feature path must be DETECTED. This is the assertion
    // that makes the oracle a test of OUR code and not just of Deriv's.
    const drifted = certifyNull(75, honest, (c) => {
      const r = logReturns(c);
      // A drift of a fifth of a σ per bar — small enough to be invisible on a
      // chart, large enough that a backtest would call it an edge.
      return r.map((x) => x + 0.0002);
    });
    assert(!drifted.ok, "a drift-injecting feature path is DETECTED (ok === false)");
    assert(drifted.meanCiExcludesZero, `…the mean CI EXCLUDES zero — ${drifted.detail}`);

    // A shape distortion is caught by the KS arm rather than the mean arm.
    const squashed = certifyNull(75, honest, (c) =>
      logReturns(c).map((x) => Math.sign(x) * Math.abs(x) ** 0.5 * 0.001));
    assert(!squashed.ok, "a shape-distorting feature path is DETECTED too");

    // Under-powered samples REFUSE to certify rather than certifying weakly.
    const tiny = certifyNull(75, generateSyntheticNullSeries({ volIndex: 75, bars: 50, seed: 7 }));
    assert(!tiny.ok && tiny.detail.startsWith("INSUFFICIENT_SAMPLE"),
      "an under-powered sample refuses to certify (an under-powered pass is the dangerous one)");

    // Determinism: the same seed gives the same series.
    const a = generateSyntheticNullSeries({ volIndex: 75, bars: 500, seed: 9 });
    const b = generateSyntheticNullSeries({ volIndex: 75, bars: 500, seed: 9 });
    assert(a.every((x, i) => x === b[i]), "the null substrate is reproducible from its seed");
  }

  // ── 7b. CPCVEngine ─────────────────────────────────────────────────────────
  console.log("\n7b CPCVEngine — purging removes a planted label leak");
  {
    const splits = cpcvSplits({ nObs: 1000, nGroups: 6, p: 2, horizon: 5, embargo: 5 });
    assert(splits.length === 15, `C(6,2) = 15 combinatorial splits (got ${splits.length})`);
    assert(
      splits.every((s) => s.testIdx.length > 0 && s.trainIdx.length > 0),
      "every split has a non-empty train and test set",
    );
    assert(
      splits.every((s) => s.testIdx.every((i) => !s.trainIdx.includes(i))),
      "train and test never share an observation",
    );
    assert(splits.some((s) => s.purgedCount > 0), "purging actually removed observations");
    assert(splits.some((s) => s.embargoedCount > 0), "the embargo actually removed observations");
    assert(
      splits.every((s) => minTrainTestGap(s) >= 5),
      "after purging, NO training observation is within the 5-bar label window of a test observation",
    );

    // Without purging the gap is 1 — adjacent samples share almost their whole
    // label window, which is exactly the leak.
    const unpurged = cpcvSplits({ nObs: 1000, nGroups: 6, p: 2, horizon: 1, embargo: 0 });
    assert(
      unpurged.some((s) => minTrainTestGap(s) === 1),
      "with no purge or embargo, training samples sit DIRECTLY adjacent to test samples",
    );

    // ── The leak, planted and then removed ───────────────────────────────────
    // e[t] are iid shocks. The label y[t] = e[t] + … + e[t+4] is a 5-bar FORWARD
    // return, so y[t] and y[t-1] share four of their five shocks. A strategy that
    // copies the label of a nearby TRAINING bar therefore knows part of the test
    // bar's outcome — without ever seeing the test bar.
    const HORIZON = 5;
    const N = 1200;

    // 40 short groups rather than 6 long ones, so most test bars sit near a
    // block boundary and BOTH arms collect a large sample.
    //
    // Test bars are sampled NON-OVERLAPPING (every HORIZON-th bar) and pooled
    // across 8 independent shock sequences. Both details are necessary, and the
    // first version of this test lacked them: with overlapping labels a whole
    // run of test bars shares one position and their returns are heavily
    // autocorrelated, so the sample standard deviation understates the variance
    // of the mean and the Sharpe's true standard error is many times 1/√n. That
    // is not a leak — it is a measurement artefact — but it looked like one
    // (a purged Sharpe of 0.17 that should have been ~0), and mistaking the two
    // is exactly the error this whole package exists to prevent.
    const MAX_SEARCH = 10;
    const SEEDS = [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031];

    function nearestTrainSharpe(horizon: number, embargo: number): { sr: number; n: number } {
      const sp = cpcvSplits({ nObs: N, nGroups: 40, p: 2, horizon, embargo });
      const rets: number[] = [];
      for (const seed of SEEDS) {
        const g = gaussian(seeded(seed));
        const e = Array.from({ length: N + HORIZON }, g);
        const y = Array.from({ length: N }, (_, t) => {
          let acc = 0;
          for (let k = 0; k < HORIZON; k++) acc += e[t + k]!;
          return acc;
        });
        for (const sp1 of sp) {
          const trainSet = new Set(sp1.trainIdx);
          for (const t of sp1.testIdx) {
            if (t % HORIZON !== 0) continue; // non-overlapping labels only
            let sum = 0;
            let n = 0;
            for (let d = 1; d <= MAX_SEARCH && n < 3; d++) {
              for (const j of [t - d, t + d]) {
                if (n < 3 && j >= 0 && j < N && trainSet.has(j)) { sum += y[j]!; n++; }
              }
            }
            if (n === 0) continue;
            rets.push(Math.sign(sum) * y[t]!);
          }
        }
      }
      return { sr: sharpe(rets), n: rets.length };
    }

    const leakedR = nearestTrainSharpe(1, 0); // horizon 1 ⇒ effectively no purge
    const purgedR = nearestTrainSharpe(HORIZON, HORIZON); // correct purge + embargo
    const leaked = leakedR.sr;
    const purged = purgedR.sr;
    console.log(
      `    leaked Sharpe = ${leaked.toFixed(4)} (n=${leakedR.n}), ` +
        `purged Sharpe = ${purged.toFixed(4)} (n=${purgedR.n})`,
    );
    assert(leaked > 0.15, `the planted leak INFLATES Sharpe (${leaked.toFixed(4)} > 0.15)`);
    assert(
      Math.abs(purged) < 0.05,
      `purging collapses it to ~0 (|${purged.toFixed(4)}| < 0.05)`,
    );
    assert(
      leaked > Math.abs(purged) * 3,
      "the two are not statistically indistinguishable — the leak was genuinely removed",
    );
    assert(
      purgedR.n > 1000 && leakedR.n > 1000,
      `…both arms measured over a large sample (leaked n=${leakedR.n}, purged n=${purgedR.n}) — no sample-size artefact`,
    );
  }

  // ── 7c. DeflatedSharpe ─────────────────────────────────────────────────────
  console.log("\n7c DeflatedSharpe — the null maximum deflates to non-significant");
  {
    assert(expectedMaxSharpe(1, 0.1) === 0, "one trial needs no multiple-testing correction");
    assert(
      expectedMaxSharpe(1000, 0.1) > expectedMaxSharpe(10, 0.1),
      "the expected maximum Sharpe GROWS with the number of trials",
    );
    near(expectedMaxSharpe(1000, 0.1) / 0.1, 3.24, 0.35,
      "E[max SR]/σ_SR for 1000 trials is ≈ √(2 ln 1000) ≈ 3.7 in the right neighbourhood");

    // Negative skew and fat tails must LOWER confidence for the same Sharpe.
    const plain = deflatedSharpe({
      observedSharpe: 0.15, trackLength: 1000, skew: 0, kurtosis: 3,
      nTrials: 10, trialSharpeSd: 0.03,
    });
    const tailRisk = deflatedSharpe({
      observedSharpe: 0.15, trackLength: 1000, skew: -2, kurtosis: 12,
      nTrials: 10, trialSharpeSd: 0.03,
    });
    assert(tailRisk.dsr < plain.dsr,
      `negative skew + fat tails LOWER the DSR (${tailRisk.dsr.toFixed(4)} < ${plain.dsr.toFixed(4)})`);
    assert(deflatedSharpe({
      observedSharpe: NaN, trackLength: 1000, skew: 0, kurtosis: 3, nTrials: 10, trialSharpeSd: 0.03,
    }).dsr === 0, "a degenerate input fails CLOSED at dsr = 0, never NaN");

    // THE CALIBRATION: 100 experiments, each searching 500 IID-null strategies.
    // The winner of each search must be declared significant at most ~5% of the
    // time. Without deflation it would be declared significant nearly always.
    const EXPERIMENTS = 100;
    const TRIALS = 500;
    const T = 250;
    let deflatedSignificant = 0;
    let naiveSignificant = 0;
    for (let exp = 0; exp < EXPERIMENTS; exp++) {
      const gg = gaussian(seeded(1000 + exp));
      const sharpes: number[] = [];
      let bestIdx = 0;
      let bestSr = -Infinity;
      let bestRet: number[] = [];
      for (let k = 0; k < TRIALS; k++) {
        const r = Array.from({ length: T }, () => gg() * 0.01);
        const sr = sharpe(r);
        sharpes.push(sr);
        if (sr > bestSr) { bestSr = sr; bestIdx = k; bestRet = r; }
      }
      void bestIdx;
      const sd = stdev(sharpes);
      const d = deflatedSharpe({
        observedSharpe: bestSr,
        trackLength: T,
        skew: skewness(bestRet),
        kurtosis: kurtosis(bestRet),
        nTrials: TRIALS,
        trialSharpeSd: sd,
      });
      if (d.dsr >= 0.95) deflatedSignificant++;
      // The naive comparison the deflation replaces: SR > 0 at 95% confidence
      // WITHOUT charging for the 500 trials.
      const naive = deflatedSharpe({
        observedSharpe: bestSr, trackLength: T,
        skew: skewness(bestRet), kurtosis: kurtosis(bestRet),
        nTrials: 1, trialSharpeSd: sd,
      });
      if (naive.dsr >= 0.95) naiveSignificant++;
    }
    const rate = deflatedSignificant / EXPERIMENTS;
    const naiveRate = naiveSignificant / EXPERIMENTS;
    console.log(`    deflated false-positive rate = ${(rate * 100).toFixed(1)}% ` +
      `vs naive ${(naiveRate * 100).toFixed(1)}%`);
    assert(rate <= 0.05,
      `the max of ${TRIALS} null Sharpes is significant at most 5% of the time (got ${(rate * 100).toFixed(1)}%)`);
    assert(naiveRate > 0.5,
      `…while the UNDEFLATED comparison calls the same noise significant ${(naiveRate * 100).toFixed(1)}% of the time`);
  }

  // ── 7d. PBOEstimator ───────────────────────────────────────────────────────
  console.log("\n7d PBOEstimator — pure noise gives PBO ≈ 0.5");
  {
    const gg = gaussian(seeded(777));
    const noise = Array.from({ length: 40 }, () =>
      Array.from({ length: 400 }, () => gg() * 0.01));
    const r = estimatePbo(noise, 10);
    console.log(`    ${r.detail}`);
    assert(r.combinations === 252, `C(10,5) = 252 CSCV partitions (got ${r.combinations})`);
    assert(r.pbo >= 0.1, `PBO is NOT below 0.1 on pure noise (got ${r.pbo.toFixed(4)}) — the failure that matters`);
    near(r.pbo, 0.5, 0.2, "PBO ≈ 0.5 on a pure-noise ensemble");
    near(r.medianOosRank, 0.5, 0.2, "the in-sample winner's median OOS rank ≈ 0.5");

    // A genuinely persistent edge must give a LOW PBO — otherwise the estimator
    // rejects everything and is just as useless as one that accepts everything.
    const gg2 = gaussian(seeded(888));
    const withEdge = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 400 }, () => gg2() * 0.01 + (i === 0 ? 0.004 : 0)));
    const r2 = estimatePbo(withEdge, 10);
    console.log(`    persistent-edge ensemble: ${r2.detail}`);
    assert(r2.pbo < 0.1,
      `a genuinely persistent edge gives a LOW PBO (${r2.pbo.toFixed(4)} < 0.1) — the estimator is not merely a rejector`);

    assert(Number.isNaN(estimatePbo([[1, 2, 3]], 10).pbo),
      "a single strategy cannot be ranked against a field — PBO is NaN, not 0");
  }

  // ── 7e. THE KILLER TEST ────────────────────────────────────────────────────
  console.log("\n7e THE KILLER TEST — zero certified edges on honest V75");
  {
    // Real OHLC, sampled from the same driftless GBM at sub-bar resolution. NOT
    // wicks synthesised from the close series: a fixed wick geometry makes
    // wick-rejection strategies structurally unable to fire, and a family that
    // never takes a position has not been searched, it has been skipped.
    const { bars, closes } = generateSyntheticNullBars({
      volIndex: 75, bars: 6000, seed: 20260815, subSteps: 12,
    });

    // Confirm the substrate is null BEFORE searching it. Searching a substrate
    // you have not certified proves nothing about the searcher.
    const cert = certifyNull(75, closes);
    assert(cert.ok, `the V75 substrate is certified null before the search — ${cert.detail}`);

    const variants = allStrategyVariants();
    const familiesCovered = new Set(variants.map((v) => v.familyKey));
    console.log(`    sweeping ${variants.length} variants across ${familiesCovered.size} families`);
    assert(
      FAMILY_KEYS.every((f) => familiesCovered.has(f)),
      `all ${FAMILY_KEYS.length} strategyEngine families are swept (${[...familiesCovered].join(", ")})`,
    );
    assert(variants.length >= 40, `the grid is a real search, not a token one (${variants.length} variants)`);

    const trials: TrialResult[] = variants.map((v) => ({
      key: v.key,
      familyKey: v.familyKey,
      returns: strategyReturns(v.positions(bars), closes),
    }));

    // Sanity: the search must actually TRADE, or "zero edges" is vacuous. This
    // is checked per FAMILY as well as overall, because a silently inactive
    // family means that family was never searched at all.
    const active = trials.filter((t) => t.returns.some((r) => r !== 0));
    const inactive = trials.filter((t) => !t.returns.some((r) => r !== 0));
    if (inactive.length > 0) {
      console.log(`    ${inactive.length} variant(s) never traded: ${inactive.map((t) => t.key).join(", ")}`);
    }
    // Reported rather than hidden. The inactive ones are the tightest
    // volatility-expansion thresholds, and that is a TRUE FACT about the
    // substrate rather than a defect: GBM has CONSTANT volatility by
    // construction, so there is no vol clustering for an expansion filter to
    // fire on. What must not happen is a whole FAMILY going silent — a family
    // that never takes a position was not searched, it was skipped, and "no edge
    // found" for it would be a lie.
    const activeFamilies = new Set(active.map((t) => t.familyKey));
    assert(
      FAMILY_KEYS.every((f) => activeFamilies.has(f)),
      `every one of the ${FAMILY_KEYS.length} families actually traded — a silent family is a family never searched`,
    );
    assert(
      active.length >= trials.length * 0.75,
      `at least 75% of variants take positions (${active.length}/${trials.length}) — otherwise "no edge" is largely vacuous`,
    );

    const report = validateFamily("ALL_FAMILIES_V75", trials, {
      cpcv: { nGroups: 6, p: 2, horizon: 5, embargo: 5 },
      pboBlocks: 10,
    });

    console.log(`    ${report.detail}`);
    const best = [...report.candidates].sort((a, b) => b.dsr - a.dsr)[0]!;
    console.log(
      `    best candidate: ${best.key} — OOS Sharpe ${best.oosSharpe.toFixed(4)}, ` +
        `DSR ${best.dsr.toFixed(4)}, PBO ${best.pbo.toFixed(4)}`,
    );

    assert(
      report.survivors.length === 0,
      `ZERO edges certified on honest V75 (${report.survivors.length} survivors — any survivor means the factory certifies noise)`,
    );
    assert(
      report.candidates.every((c) => c.vetoes.length > 0),
      "every candidate was vetoed by at least one of CPCV / DSR / PBO",
    );
    assert(
      report.nTrials === trials.length,
      `the multiple-testing correction was charged for ALL ${trials.length} trials (got ${report.nTrials})`,
    );

    // The report is hash-chained, so a verdict cannot be quietly restated later.
    assert(/^[0-9a-f]{64}$/.test(report.reportHash), "the report carries a sha256 chain hash");
    const again = validateFamily("ALL_FAMILIES_V75", trials, {
      cpcv: { nGroups: 6, p: 2, horizon: 5, embargo: 5 }, pboBlocks: 10,
    });
    assert(again.reportHash === report.reportHash, "…and the same inputs give the same hash");

    // THE TEST MUST BE ABLE TO FAIL. A candidate with a genuine, large,
    // persistent edge injected into the same field MUST survive — otherwise
    // "zero edges" would be an artefact of thresholds nothing can clear.
    const edgeReturns = trials[0]!.returns.map((_, i) => 0.004 + (i % 7) * 1e-5);
    const withPlanted: TrialResult[] = [
      { key: "PLANTED_EDGE", familyKey: "PlantedEdge", returns: edgeReturns },
      ...trials,
    ];
    const plantedReport = validateFamily("ALL_FAMILIES_V75_PLUS_PLANTED", withPlanted, {
      cpcv: { nGroups: 6, p: 2, horizon: 5, embargo: 5 }, pboBlocks: 10,
    });
    const planted = plantedReport.candidates.find((c) => c.key === "PLANTED_EDGE")!;
    console.log(
      `    planted edge: OOS Sharpe ${planted.oosSharpe.toFixed(4)}, ` +
        `DSR ${planted.dsr.toFixed(4)}, PBO ${planted.pbo.toFixed(4)}, verdict ${planted.verdict}`,
    );
    assert(
      planted.verdict === "PASS",
      `a genuine planted edge DOES pass (${planted.verdict}) — the thresholds are clearable, so "zero" is a finding, not an artefact`,
    );
    assert(
      plantedReport.survivors.length === 1 && plantedReport.survivors[0]!.key === "PLANTED_EDGE",
      "…and it is the ONLY survivor — none of the real strategies rode in with it",
    );
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "validationFactoryTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[validationFactoryTest] FAILED:", err);
      process.exit(1);
    },
  );
}
