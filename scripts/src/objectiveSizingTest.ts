// Test: the objective kernel + the sizing chain (@workspace/risk).
//
// Three claims carry this file:
//
//   1. f* IS ACTUALLY OPTIMAL. Not asserted from the algebra — searched. 10,000
//      fractions are scored on the log-growth rate and NONE beats f*. If the
//      formula is ever "simplified" into something subtly different, this fails
//      by construction rather than by someone noticing.
//
//   2. RUIN IS −∞, NOT A BAD SCORE. A fraction that can take wealth to zero
//      returns -Infinity, so no optimiser can trade a small ruin probability
//      against enough upside. A finite penalty would permit exactly that trade.
//
//   3. NOTHING CAN SIZE UP. Every stage after the objective can only reduce. The
//      learned nudge is property-tested over 5,000 draws, and a nudge outside
//      [0,1] THROWS rather than being clamped — because a model asking to size
//      up is a defect to surface, not an input to sanitise.
//
// The no-edge rule is checked with `=== 0` and `Object.is`, never `< 1e-9`: an
// unmeasured edge sizes to EXACTLY zero. Undefined, null, NaN, zero and negative
// edges all land there. An unmeasured edge is not a small edge, it is an unknown
// one.
//
// Fuzzing uses a SEEDED generator, never Math.random(), so a failure here is
// reproducible from the seed alone rather than being a story about a run nobody
// can repeat.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import {
  kellyStar,
  logGrowthRate,
  expectedLogWealth,
  volTargetBaseFrac,
  kellyCapGovernor,
  enforceTightenOnly,
  applyFloorStack,
  dailyWeeklyLossCapFloor,
  stopRatchetFloor,
  decideSize,
  hashInputs,
  stableStringify,
  type SizingInputs,
} from "@workspace/risk";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

/**
 * mulberry32 — a small, fast, seeded PRNG. Deterministic by design: a failing
 * fuzz case is reproducible from the seed, which `Math.random()` could never be.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  function near(actual: number, expected: number, tol: number, label: string) {
    assert(Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
      `${label} (got ${actual}, expected ${expected} ±${tol})`);
  }

  console.log("objectiveSizingTest");
  console.log("===================\n");

  // ── A0.1 — f* is optimal, by search ────────────────────────────────────────
  console.log("A0 ObjectiveKernel — f* beaten by nobody (10,000-fraction search)");
  {
    const mu = 0.08;
    const sigmaSq = 0.04;
    const fStar = kellyStar(mu, sigmaSq);
    near(fStar, 2, 1e-12, "f* = μ/σ² = 0.08/0.04 = 2");

    const gStar = logGrowthRate(fStar, mu, sigmaSq);
    let beaten = 0;
    let bestOther = -Infinity;
    const N = 10_000;
    for (let i = 0; i <= N; i++) {
      const f = (i / N) * 4 * fStar - fStar; // sweep [-f*, 3f*], straddling f*
      const g = logGrowthRate(f, mu, sigmaSq);
      if (g > gStar + 1e-12) beaten++;
      if (f !== fStar && g > bestOther) bestOther = g;
    }
    assert(beaten === 0, `objective: ${beaten}/${N} fractions beat f* (must be 0)`);
    assert(bestOther <= gStar, "the best non-optimal fraction does not exceed g(f*)");

    // The asymmetry that justifies the quarter-Kelly cap: over-sizing hurts far
    // more than under-sizing by the same amount, and past 2f* it is worse than
    // not trading at all.
    const under = logGrowthRate(fStar * 0.5, mu, sigmaSq);
    const over = logGrowthRate(fStar * 1.5, mu, sigmaSq);
    near(under, over, 1e-12, "g is symmetric at ±50% of f* (a parabola in f)");
    assert(logGrowthRate(2 * fStar, mu, sigmaSq) <= 0,
      "betting 2f* has a growth rate of zero — all the edge is spent on variance");
    assert(logGrowthRate(2.5 * fStar, mu, sigmaSq) < 0,
      "betting beyond 2f* DESTROYS wealth a flat account would have kept");
    // Quarter Kelly: ~7% of the growth rate given up for a quarter of the size.
    near(logGrowthRate(0.25 * fStar, mu, sigmaSq) / gStar, 0.4375, 1e-12,
      "quarter Kelly retains 43.75% of the growth rate at 25% of the size");
  }

  // Degenerate inputs fail to zero, never to Infinity or NaN.
  console.log("\n  kellyStar degenerate inputs fail to zero");
  for (const [mu, s2] of [[0.1, 0], [0.1, -1], [0, 0]] as const) {
    assert(kellyStar(mu, s2) === 0, `kellyStar(${mu}, ${s2}) === 0 (never Infinity/NaN)`);
  }

  // ── A0.2 — ruin is −∞ ──────────────────────────────────────────────────────
  console.log("\nA0 ObjectiveKernel — ruin is −∞, not a bad score");
  {
    const fair = [{ r: 1, p: 0.5 }, { r: -1, p: 0.5 }];
    assert(expectedLogWealth(1, fair) === -Infinity,
      "betting the full stake against a −100% outcome is −Infinity");
    assert(Object.is(expectedLogWealth(1.5, fair), -Infinity),
      "over-betting past ruin is −Infinity");
    assert(Number.isFinite(expectedLogWealth(0.5, fair)),
      "a survivable fraction has a finite score");
    assert(expectedLogWealth(0, fair) === 0, "betting nothing neither grows nor ruins");

    // An enormous upside cannot average ruin back up — the point of using log.
    const lottery = [{ r: 1e9, p: 0.999 }, { r: -1, p: 0.001 }];
    assert(expectedLogWealth(1, lottery) === -Infinity,
      "a 1e9 upside at p=0.999 does NOT rescue a 0.1% chance of ruin");
    assert(Number.isFinite(expectedLogWealth(0.99, lottery)),
      "…while a fraction that survives the loss scores finitely");

    // Against a genuinely favourable discrete bet, the search agrees with theory.
    const edge = [{ r: 1, p: 0.6 }, { r: -1, p: 0.4 }];
    let bestF = 0;
    let bestG = -Infinity;
    for (let i = 0; i <= 10_000; i++) {
      const f = i / 10_000;
      const g = expectedLogWealth(f, edge);
      if (g > bestG) { bestG = g; bestF = f; }
    }
    near(bestF, 0.2, 1e-3, "discrete Kelly for a 60/40 even-money bet is f = 0.2 (2p−1)");
  }

  // ── A1 — VolTargetSizer ────────────────────────────────────────────────────
  console.log("\nA1 VolTargetSizer — σ_expected ≤ 0 or NaN ⇒ exactly 0");
  {
    const base = { targetRiskFrac: 0.02, sigmaTarget: 0.10 };
    const ok = volTargetBaseFrac({ ...base, sigmaExpected: 0.20 });
    near(ok.baseFrac, 0.01, 1e-12, "double the target vol ⇒ half the size");
    assert(ok.reason === "OK", "…reason OK");
    near(volTargetBaseFrac({ ...base, sigmaExpected: 0.10 }).baseFrac, 0.02, 1e-12,
      "at target vol the size is the target risk fraction");

    for (const bad of [0, -0.1, NaN, Infinity * 0]) {
      const r = volTargetBaseFrac({ ...base, sigmaExpected: bad });
      assert(r.baseFrac === 0 && r.reason === "NO_SIGMA",
        `σ_expected = ${bad} ⇒ baseFrac exactly 0, reason NO_SIGMA`);
    }
    // The NaN case is the one a `<= 0` guard would let through.
    assert(!Number.isNaN(volTargetBaseFrac({ ...base, sigmaExpected: NaN }).baseFrac),
      "a NaN volatility can never produce a NaN size");
  }

  // ── A2 — KellyCapGovernor ──────────────────────────────────────────────────
  console.log("\nA2 KellyCapGovernor — no measured edge ⇒ EXACTLY 0");
  {
    const fStar = 2;
    for (const edge of [undefined, null, NaN, 0, -0.01, -Infinity] as const) {
      const r = kellyCapGovernor({ edgeOOS: edge, varOOS: 0.04, fStar });
      assert(r.fUsed === 0 && Object.is(r.fUsed, 0) && r.reason === "NO_EDGE",
        `edgeOOS = ${String(edge)} ⇒ fUsed EXACTLY 0 (=== 0), reason NO_EDGE`);
    }
    for (const v of [0, -1, NaN]) {
      const r = kellyCapGovernor({ edgeOOS: 0.08, varOOS: v, fStar });
      assert(r.fUsed === 0 && r.reason === "NO_EDGE",
        `varOOS = ${v} ⇒ fUsed exactly 0 (no variance, no basis for a size)`);
    }

    // The quarter-Kelly cap binds when the raw answer is ambitious.
    const capped = kellyCapGovernor({ edgeOOS: 0.08, varOOS: 0.04, fStar });
    near(capped.fUsed, 0.5, 1e-12, "raw 2.0 is capped to 0.25·f* = 0.5");
    assert(capped.reason === "CAP_BOUND", "…reason CAP_BOUND");
    assert(capped.fUsed < 2, "the cap genuinely reduced the raw Kelly fraction");

    // …and does not bind when the measured edge is modest.
    const uncapped = kellyCapGovernor({ edgeOOS: 0.004, varOOS: 0.04, fStar });
    near(uncapped.fUsed, 0.1, 1e-12, "a modest raw 0.1 passes below the 0.5 cap");
    assert(uncapped.reason === "OK", "…reason OK");

    // Exactly at the cap, the cap binds (>=, not >).
    const exact = kellyCapGovernor({ edgeOOS: 0.02, varOOS: 0.04, fStar });
    near(exact.fUsed, 0.5, 1e-12, "a raw fraction exactly at the cap is CAP_BOUND");
    assert(exact.reason === "CAP_BOUND", "…reason CAP_BOUND at the boundary");

    // f* = 0 means the cap is 0 — no objective, no size.
    assert(kellyCapGovernor({ edgeOOS: 0.08, varOOS: 0.04, fStar: 0 }).fUsed === 0,
      "f* = 0 ⇒ the cap is 0, whatever the measured edge");

    // REGRESSION — found by the 5,000-draw monotonicity fuzz below. A negative
    // f* (μ < 0) makes the cap `0.25·f*` negative, and since a positive raw
    // fraction always exceeds it, the governor returned that NEGATIVE value as a
    // size. A negative size is not a short — direction is decided elsewhere — so
    // it is a bug that would have propagated through the chain comparing false
    // against every subsequent ceiling.
    for (const fStarBad of [-2, -0.001, NaN]) {
      const r = kellyCapGovernor({ edgeOOS: 0.08, varOOS: 0.04, fStar: fStarBad });
      assert(r.fUsed === 0 && r.reason === "NO_EDGE",
        `f* = ${fStarBad} ⇒ EXACTLY 0, never a negative size`);
    }
    const negMu = decideSize({
      mu: -0.08, sigmaSq: 0.04,
      volTarget: { targetRiskFrac: 0.02, sigmaTarget: 0.1, sigmaExpected: 0.1 },
      edgeOOS: 0.004, varOOS: 0.04,
    });
    assert(negMu.finalSize === 0 && negMu.deterministicSize === 0,
      "a negative-μ instrument sizes to 0 end-to-end, not to a negative fraction");
  }

  // ── A3 — TightenOnly ───────────────────────────────────────────────────────
  console.log("\nA3 TightenOnly — the learned nudge may only reduce (5,000 draws)");
  {
    const rnd = seeded(0x5eed);
    let violations = 0;
    let strictlyTightened = 0;
    for (let i = 0; i < 5000; i++) {
      const deterministic = rnd() * 10;
      const nudge = rnd();
      const applied = enforceTightenOnly(deterministic, nudge);
      if (!(applied <= deterministic + 1e-15)) violations++;
      if (applied < deterministic) strictlyTightened++;
    }
    assert(violations === 0, `property: applied ≤ deterministic in 5000/5000 draws (${violations} violations)`);
    assert(strictlyTightened > 4900, `…and the nudge actually bites (${strictlyTightened}/5000 strictly tightened)`);

    near(enforceTightenOnly(1, 1), 1, 0, "nudge = 1 is a no-op");
    near(enforceTightenOnly(1, 0), 0, 0, "nudge = 0 flattens the size to zero");
    near(enforceTightenOnly(2, 0.5), 1, 0, "nudge = 0.5 halves the size");
    // The invariant holds for a negative deterministic input too, where a bare
    // multiply would move the value UP toward zero.
    assert(enforceTightenOnly(-2, 0.5) === -2, "a negative size is not raised toward zero by a nudge");

    for (const bad of [1.0001, 1.5, 2, -0.0001, -1, NaN, Infinity, -Infinity]) {
      let threw = false;
      try { enforceTightenOnly(1, bad); } catch { threw = true; }
      assert(threw, `nudge = ${bad} THROWS (a model asking to size up is a defect, not an input to clamp)`);
    }
  }

  // ── A4 — FloorStack ────────────────────────────────────────────────────────
  console.log("\nA4 FloorStack — the tightest floor wins, and it says which");
  {
    const r = applyFloorStack([
      { name: "DailyWeeklyLossCap", maxFrac: 0.05 },
      { name: "StopRatchet", maxFrac: 0.02 },
      { name: "Concentration", maxFrac: 0.10 },
    ]);
    near(r.maxFrac, 0.02, 1e-12, "min() over the stack picks 0.02");
    assert(r.bindingFloor === "StopRatchet", "…and names StopRatchet as the binding floor");

    const empty = applyFloorStack([]);
    assert(empty.maxFrac === Infinity && empty.bindingFloor === null,
      "an empty stack imposes no ceiling and names no floor");

    const tie = applyFloorStack([
      { name: "First", maxFrac: 0.03 },
      { name: "Second", maxFrac: 0.03 },
    ]);
    assert(tie.bindingFloor === "First", "ties resolve to the first floor listed (documented tie-break)");

    // DailyWeeklyLossCap: linear in remaining budget, exactly 0 when spent,
    // and fail-safe (0) on unknown consumption.
    near(dailyWeeklyLossCapFloor({ baseFrac: 0.04, consumedFrac: 0 }).maxFrac, 0.04, 1e-12,
      "loss cap: nothing consumed ⇒ full base size");
    near(dailyWeeklyLossCapFloor({ baseFrac: 0.04, consumedFrac: 0.5 }).maxFrac, 0.02, 1e-12,
      "loss cap: half consumed ⇒ half size");
    assert(dailyWeeklyLossCapFloor({ baseFrac: 0.04, consumedFrac: 1 }).maxFrac === 0,
      "loss cap: fully consumed ⇒ EXACTLY 0");
    assert(dailyWeeklyLossCapFloor({ baseFrac: 0.04, consumedFrac: 1.7 }).maxFrac === 0,
      "loss cap: over-consumed clamps to 0, never negative");
    for (const bad of [null, undefined, NaN, Infinity]) {
      assert(dailyWeeklyLossCapFloor({ baseFrac: 0.04, consumedFrac: bad as number }).maxFrac === 0,
        `loss cap: consumed = ${String(bad)} ⇒ 0 (unknown treated as SPENT, never as available)`);
    }

    near(stopRatchetFloor({ riskPerUnit: 0.01, stopDistance: 0.5 }).maxFrac, 0.02, 1e-12,
      "stop ratchet: size is riskPerUnit / stopDistance");
    assert(stopRatchetFloor({ riskPerUnit: 0.01, stopDistance: 0 }).maxFrac === 0,
      "stop ratchet: no stop distance ⇒ 0 (an unbounded loss sizes to nothing)");
    for (const bad of [null, undefined, NaN, -1]) {
      assert(stopRatchetFloor({ riskPerUnit: 0.01, stopDistance: bad as number }).maxFrac === 0,
        `stop ratchet: stopDistance = ${String(bad)} ⇒ 0`);
    }
  }

  // ── A5 — SizingDecider ─────────────────────────────────────────────────────
  console.log("\nA5 SizingDecider — composition, determinism, monotonicity");
  {
    const base: SizingInputs = {
      mu: 0.08,
      sigmaSq: 0.04,
      volTarget: { targetRiskFrac: 0.02, sigmaTarget: 0.10, sigmaExpected: 0.10 },
      edgeOOS: 0.004,
      varOOS: 0.04,
    };

    const d = decideSize(base);
    near(d.fStar, 2, 1e-12, "decision carries f* = 2");
    // vol target 0.02 vs kelly-capped 0.1 → the vol target is the tighter ceiling
    near(d.deterministicSize, 0.02, 1e-12, "deterministic size is min(volTarget, kellyCap) = 0.02");
    near(d.finalSize, 0.02, 1e-12, "no nudge, no floors ⇒ final = deterministic");
    assert(d.bindingFloor === null, "no floor bound the size");

    // Determinism: identical inputs give an identical hash and an identical size.
    const again = decideSize({ ...base });
    assert(again.inputsHash === d.inputsHash, "determinism: same inputs ⇒ identical inputsHash");
    assert(again.finalSize === d.finalSize, "determinism: same inputs ⇒ identical finalSize");
    // Key ORDER must not change the hash…
    const reordered = decideSize({
      varOOS: base.varOOS, edgeOOS: base.edgeOOS, volTarget: base.volTarget,
      sigmaSq: base.sigmaSq, mu: base.mu,
    });
    assert(reordered.inputsHash === d.inputsHash, "determinism: key order does not change the hash");
    // …but any VALUE change must.
    assert(decideSize({ ...base, mu: 0.0800001 }).inputsHash !== d.inputsHash,
      "a changed input changes the hash");
    // `undefined` and `null` edges are distinguishable in the hash.
    assert(hashInputs({ ...base, edgeOOS: undefined }) !== hashInputs({ ...base, edgeOOS: null }),
      "an undefined edge and a null edge hash differently (no silent collision)");
    assert(stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }),
      "stableStringify sorts keys at every depth");
    assert(stableStringify({ x: NaN }) === '{"x":"__NaN__"}',
      "non-finite numbers are named rather than becoming null");

    // No measured edge ⇒ EXACTLY zero size, whatever the vol target says.
    for (const edge of [undefined, null, NaN, 0, -1] as const) {
      const z = decideSize({ ...base, edgeOOS: edge });
      assert(z.finalSize === 0 && z.reason === "NO_EDGE",
        `decideSize with edgeOOS = ${String(edge)} ⇒ finalSize EXACTLY 0, reason NO_EDGE`);
    }
    const noSigma = decideSize({ ...base, volTarget: { ...base.volTarget, sigmaExpected: NaN } });
    assert(noSigma.finalSize === 0 && noSigma.reason === "NO_SIGMA",
      "decideSize with a NaN expected vol ⇒ finalSize exactly 0, reason NO_SIGMA");

    // Floors bind and are named.
    const withFloor = decideSize({ ...base, floors: [{ name: "DailyWeeklyLossCap", maxFrac: 0.005 }] });
    near(withFloor.finalSize, 0.005, 1e-12, "a tighter floor reduces the final size");
    assert(withFloor.bindingFloor === "DailyWeeklyLossCap", "…and is named as the binding floor");
    const looseFloor = decideSize({ ...base, floors: [{ name: "Concentration", maxFrac: 0.9 }] });
    near(looseFloor.finalSize, 0.02, 1e-12, "a floor above the size does not bind");
    assert(looseFloor.bindingFloor === null, "…and is not reported as binding");

    // The nudge tightens and never raises.
    near(decideSize({ ...base, nudge: 0.5 }).finalSize, 0.01, 1e-12, "nudge 0.5 halves the final size");
    near(decideSize({ ...base, nudge: 0 }).finalSize, 0, 1e-12, "nudge 0 flattens the final size");
    let threw = false;
    try { decideSize({ ...base, nudge: 1.2 }); } catch { threw = true; }
    assert(threw, "decideSize propagates the throw for a size-UP nudge");

    // ── The monotonicity invariant, fuzzed ────────────────────────────────────
    const rnd = seeded(0xC0FFEE);
    let mono = 0;
    let neg = 0;
    let nan = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const inputs: SizingInputs = {
        mu: (rnd() - 0.3) * 0.5,
        sigmaSq: rnd() * 0.2,
        volTarget: {
          targetRiskFrac: rnd() * 0.1,
          sigmaTarget: rnd() * 0.3,
          sigmaExpected: rnd() * 0.4,
        },
        edgeOOS: rnd() < 0.2 ? null : (rnd() - 0.3) * 0.1,
        varOOS: rnd() * 0.2,
        nudge: rnd(),
        floors: rnd() < 0.5 ? [{ name: "Fuzz", maxFrac: rnd() * 0.05 }] : [],
      };
      const r = decideSize(inputs);
      if (r.finalSize > r.deterministicSize + 1e-15) mono++;
      if (r.finalSize < 0) neg++;
      if (!Number.isFinite(r.finalSize)) nan++;
    }
    assert(mono === 0, `monotonicity: finalSize ≤ deterministicSize in ${N}/${N} draws (${mono} violations)`);
    assert(neg === 0, `finalSize is never negative in ${N} draws (${neg} violations)`);
    assert(nan === 0, `finalSize is always finite — never NaN or Infinity (${nan} violations)`);
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "objectiveSizingTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[objectiveSizingTest] FAILED:", err);
      process.exit(1);
    },
  );
}
