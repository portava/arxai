// Test: the discovery pipeline + FDR ledger (@workspace/discovery).
//
// Three claims:
//
//   1. FDR IS ACTUALLY CONTROLLED. 200 null hypotheses are registered and the
//      empirical false-discovery count must not exceed q·m. This is measured
//      over many independent replications, not asserted from the formula — a
//      controller that implements Benjamini–Hochberg slightly wrong (a `<`
//      instead of `≤`, rejecting only individually-clearing tests instead of the
//      whole prefix) still looks correct on inspection and fails here.
//
//   2. THE DENOMINATOR CANNOT BE UNDERSTATED. Niche-selection trials — choosing
//      WHICH instrument or session to look at — are charged exactly like
//      parameter trials, and supplying a family size smaller than the number of
//      p-values THROWS. That combination is arithmetically impossible and is the
//      signature of a family counted after some trials were dropped.
//
//   3. NOTHING CAN REACH LIVE. A hand-injected true edge routes end-to-end to a
//      PASS candidate; a null routes to REJECT; and NEITHER can set
//      liveAllowed, shadowValidated or adminApproved. That is asserted over
//      every candidate on every path, including the passing one — the passing
//      path is the one that matters, because a promotion that stops at REJECT
//      proves nothing about what happens when something succeeds.
//
// All randomness is SEEDED. Pure unit test — no DB, no network, no clock.

import {
  controlFdr,
  sharpePValue,
  preRegister,
  runDiscovery,
  nicheSelectionCount,
  stableStringify,
  REFUSING_VALIDATION_PORT,
  type HypothesisSpec,
  type TrialOutcome,
  type ValidationPort,
} from "@workspace/discovery";
import { validateFamily, buildCostModel, netReturns, costEvidence } from "@workspace/validation";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

/** mulberry32 — seeded, so a failure is reproducible from the seed alone. */
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
function gaussian(rnd: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = rnd();
    if (u <= 0) u = Number.MIN_VALUE;
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/**
 * The real Phase 7 factory, behind the local port.
 *
 * The adapter is deliberately thin: Phase 8 depends on the PORT, not on Phase 7,
 * so it typechecks and commits regardless of merge order. This test wires the
 * real thing in so the end-to-end path is genuinely exercised rather than being
 * validated by a stub that agrees with it.
 */
// C7: the factory refuses gross-only certification, so the port nets every
// trial through the declared V75 cost model first. Trial outcomes carry only a
// return series (no position path), so the CONSERVATIVE schedule applies: a
// full round trip charged on every observation — the upper bound on turnover.
const V75_COST_MODEL = buildCostModel({
  instrument: "Volatility 75 Index",
  instrumentClass: "synthetic",
  venue: "deriv",
});

const REAL_PORT: ValidationPort = {
  validateFamily(familyKey, trials, chargedTrials) {
    const r = validateFamily(
      familyKey,
      trials.map((t) => ({
        key: t.key,
        familyKey: t.familyKey,
        returns: netReturns(t.returns, V75_COST_MODEL, { kind: "roundTripPerObservation", size: 1 }).net,
      })),
      {
        cpcv: { nGroups: 6, p: 2, horizon: 5, embargo: 5 },
        pboBlocks: 10,
        chargedTrials,
        costs: costEvidence(V75_COST_MODEL, "roundTripPerObservation"),
      },
    );
    return {
      candidates: r.candidates.map((c) => ({
        key: c.key, verdict: c.verdict, oosSharpe: c.oosSharpe,
        dsr: c.dsr, pbo: c.pbo, vetoes: c.vetoes,
      })),
      reportHash: r.reportHash,
    };
  },
};

const SPEC: HypothesisSpec = {
  familyKey: "MeanReversionV75",
  instrument: "Volatility 75 Index",
  rule: "fade the 40-bar range extreme when RSI confirms",
  params: { lookback: 40, rsiPeriod: 14, band: 20 },
  horizon: 5,
  metric: "oos_sharpe",
};

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) { passes++; console.log(`  ✓ ${label}`); }
    else { failures++; console.error(`  ✗ ${label}`); }
  }
  function throws(fn: () => unknown, label: string) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, label);
  }

  console.log("discoveryPipelineTest");
  console.log("=====================\n");

  // ── 8b.1 — BH mechanics ────────────────────────────────────────────────────
  console.log("8b FDRController — Benjamini–Hochberg mechanics");
  {
    // A worked example, with the arithmetic written out so the expected answer
    // is derived rather than remembered. m = 4, q = 0.05 ⇒ critical values
    // 0.0125, 0.025, 0.0375, 0.05 at ranks 1..4.
    //   p=0.005 ≤ 0.0125 ✓   p=0.011 ≤ 0.025 ✓   p=0.02 ≤ 0.0375 ✓   p=0.9 ≤ 0.05 ✗
    // so the largest clearing rank is 3.
    const r = controlFdr(
      [{ key: "a", p: 0.005 }, { key: "b", p: 0.011 }, { key: "c", p: 0.02 }, { key: "d", p: 0.9 }],
      0.05, 4,
    );
    assert(r.rejections === 3, `BH rejects the first 3 of 4 (got ${r.rejections})`);
    assert(r.threshold === 0.02, `…with threshold p = 0.02, the largest clearing p (got ${r.threshold})`);
    assert(
      r.decisions.slice(0, 3).every((d) => d.rejected),
      "…and they are the three smallest",
    );
    assert(!r.decisions[3]!.rejected, "…the p = 0.9 is not rejected");
    assert(
      r.decisions.map((d) => Number(d.critical.toFixed(4))).join(",") === "0.0125,0.025,0.0375,0.05",
      "…the critical values are (rank/m)·q as stated",
    );

    // THE STEP-UP RULE. p = 0.03 does not clear its own critical value
    // (2/4·0.05 = 0.025) but IS rejected, because a larger p clears a later one.
    // Rejecting only individually-clearing tests is the most common BH bug and
    // silently changes the guarantee.
    const stepUp = controlFdr(
      [{ key: "a", p: 0.001 }, { key: "b", p: 0.03 }, { key: "c", p: 0.035 }, { key: "d", p: 0.9 }],
      0.05, 4,
    );
    assert(
      stepUp.rejections === 3,
      `step-up rejects the whole prefix, including a p that fails its own critical value (got ${stepUp.rejections}, expected 3)`,
    );
    assert(
      stepUp.decisions[1]!.p > stepUp.decisions[1]!.critical && stepUp.decisions[1]!.rejected,
      "…that middle p = 0.03 exceeds its critical 0.025 and is rejected anyway (step-UP, not step-down)",
    );

    assert(controlFdr([{ key: "a", p: 0.9 }], 0.05, 1).rejections === 0, "a large p is not rejected");
    assert(controlFdr([{ key: "a", p: 0.9 }], 0.05, 1).threshold === null, "…and there is no threshold");

    // A non-finite p becomes 1 (no evidence), never dropped — dropping it would
    // shrink the effective family and inflate every threshold.
    const nan = controlFdr([{ key: "a", p: 0.001 }, { key: "b", p: NaN }], 0.05, 2);
    assert(nan.decisions.length === 2, "a NaN p-value is kept as no-evidence, not dropped");
    assert(nan.decisions.find((d) => d.key === "b")!.p === 1, "…and treated as p = 1");

    throws(() => controlFdr([], 0, 10), "q = 0 THROWS");
    throws(() => controlFdr([], 1, 10), "q = 1 THROWS");
    throws(() => controlFdr([{ key: "a", p: 0.1 }], 0.05, 0), "familySize = 0 THROWS");

    // THE DENOMINATOR GUARD.
    throws(
      () => controlFdr([{ key: "a", p: 0.1 }, { key: "b", p: 0.2 }], 0.05, 1),
      "a familySize SMALLER than the p-value count THROWS (the signature of a dropped-trial denominator)",
    );

    // Understating m makes rejection strictly easier — the reason it is guarded.
    const honest = controlFdr([{ key: "a", p: 0.02 }], 0.05, 10);
    const understated = controlFdr([{ key: "a", p: 0.02 }], 0.05, 1);
    assert(
      honest.rejections === 0 && understated.rejections === 1,
      "understating m turns a non-discovery into a discovery — which is why m is explicit and guarded",
    );
  }

  // ── 8b.2 — FDR IS ACTUALLY CONTROLLED ──────────────────────────────────────
  console.log("\n8b FDRController — empirical control over 200 null hypotheses");
  {
    const M = 200;
    const Q = 0.1;
    const REPLICATIONS = 200;
    let totalRejections = 0;
    let worstRejections = 0;
    for (let rep = 0; rep < REPLICATIONS; rep++) {
      const rnd = seeded(4000 + rep);
      // Under the null, p-values are Uniform(0,1) by construction.
      const tests = Array.from({ length: M }, (_, i) => ({ key: `h${i}`, p: rnd() }));
      const r = controlFdr(tests, Q, M);
      totalRejections += r.rejections;
      worstRejections = Math.max(worstRejections, r.rejections);
    }
    const avg = totalRejections / REPLICATIONS;
    console.log(
      `    ${REPLICATIONS} replications × ${M} null hypotheses at q=${Q}: ` +
        `mean ${avg.toFixed(3)} rejections, worst ${worstRejections}`,
    );
    // EVERY rejection here is false by construction, so the count IS the false
    // discovery count. BH bounds its expectation by q·m₀ = q·m.
    assert(
      avg <= Q * M,
      `empirical false discoveries (${avg.toFixed(3)}) ≤ q·m (${(Q * M).toFixed(1)})`,
    );
    // The real BH guarantee is much tighter than q·m when nothing is true; a
    // controller that rejected wildly would still clear the loose bound above.
    assert(
      avg < 1,
      `…and in practice far below it (${avg.toFixed(3)} < 1 rejection per replication on pure null)`,
    );

    // Sanity in the other direction: a genuine signal IS found, so the
    // controller is not merely a rejector of everything.
    const withSignal = controlFdr(
      [
        ...Array.from({ length: 190 }, (_, i) => ({ key: `null${i}`, p: seeded(99 + i)() })),
        ...Array.from({ length: 10 }, (_, i) => ({ key: `real${i}`, p: 1e-6 })),
      ],
      Q, 200,
    );
    assert(
      withSignal.rejections >= 10,
      `10 genuine signals among 190 nulls ARE detected (${withSignal.rejections} rejections)`,
    );
  }

  // ── sharpePValue ───────────────────────────────────────────────────────────
  console.log("\n  sharpePValue");
  {
    assert(Math.abs(sharpePValue(0, 1000) - 0.5) < 1e-6, "a zero Sharpe gives p = 0.5");
    assert(sharpePValue(0.1, 1000) < 0.01, "a strong Sharpe over a long track gives a small p");
    assert(sharpePValue(0.1, 10) > 0.3, "…the same Sharpe over a short track does not");
    assert(sharpePValue(NaN, 1000) === 1, "a NaN Sharpe fails closed at p = 1");
    assert(sharpePValue(0.5, 1) === 1, "a track of 1 fails closed at p = 1");
  }

  // ── 8c.1 — pre-registration ────────────────────────────────────────────────
  console.log("\n8c Pre-registration — the anti-backdating spine");
  {
    const a = preRegister(SPEC);
    const b = preRegister({ ...SPEC });
    assert(a.preregHash === b.preregHash, "the same spec hashes identically");
    assert(/^[0-9a-f]{64}$/.test(a.preregHash), "the prereg hash is a sha256");

    // Every dimension a researcher could quietly change after the fact.
    assert(preRegister({ ...SPEC, horizon: 20 }).preregHash !== a.preregHash,
      "changing the HORIZON changes the hash (no 'we always meant 20 bars')");
    assert(preRegister({ ...SPEC, params: { ...SPEC.params, lookback: 41 } }).preregHash !== a.preregHash,
      "changing a PARAMETER changes the hash");
    assert(preRegister({ ...SPEC, metric: "oos_return" }).preregHash !== a.preregHash,
      "changing the METRIC changes the hash");
    assert(preRegister({ ...SPEC, instrument: "Volatility 100 Index" }).preregHash !== a.preregHash,
      "changing the INSTRUMENT changes the hash");

    assert(stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }),
      "key order does not change the hash");
  }

  // ── 8c.2 — a NULL routes to REJECT ─────────────────────────────────────────
  console.log("\n8c Pipeline — a null routes to REJECT");
  {
    const g = gaussian(seeded(31337));
    const trials: TrialOutcome[] = Array.from({ length: 12 }, (_, i) => ({
      key: `null_${i}`,
      // Two of the twelve are NICHE-SELECTION trials — the choice of where to
      // look, which is itself multiplicity and is usually never counted.
      isNicheSelection: i < 2,
      params: { lookback: 20 + i },
      oosReturns: Array.from({ length: 600 }, () => g() * 0.01),
    }));

    assert(nicheSelectionCount(trials) === 2, "two trials are flagged as niche-selection");

    const r = runDiscovery({
      spec: SPEC, trials, validation: REAL_PORT, q: 0.1, shadowSize: 0.001, runId: "run_null",
    });
    console.log(`    ${r.detail}`);
    assert(r.passes.length === 0, `a null family produces ZERO passing candidates (${r.passes.length})`);
    assert(r.candidates.every((c) => c.verdict === "REJECT"), "every candidate is REJECT");
    assert(
      r.familySize === 12,
      `the FDR family size is ALL 12 trials — niche-selection trials charged like parameter trials (got ${r.familySize})`,
    );
    assert(r.candidates.every((c) => c.shadowSize === 0), "a REJECT accrues no shadow size");
  }

  // ── 8c.3 — an INJECTED TRUE EDGE routes to PASS ────────────────────────────
  console.log("\n8c Pipeline — an injected true edge routes to PASS");
  {
    const g = gaussian(seeded(4242));
    // A genuine, persistent mean-reversion edge: a real positive drift in the
    // strategy's own returns, large enough to survive the multiple-testing
    // correction for a 12-trial family.
    const edge: TrialOutcome = {
      key: "real_edge",
      isNicheSelection: false,
      params: { lookback: 40 },
      oosReturns: Array.from({ length: 600 }, () => 0.004 + g() * 0.004),
    };
    const nulls: TrialOutcome[] = Array.from({ length: 11 }, (_, i) => ({
      key: `null_${i}`,
      isNicheSelection: i < 2,
      params: { lookback: 20 + i },
      oosReturns: Array.from({ length: 600 }, () => g() * 0.01),
    }));

    const r = runDiscovery({
      spec: SPEC, trials: [edge, ...nulls], validation: REAL_PORT,
      q: 0.1, shadowSize: 0.001, runId: "run_edge",
    });
    console.log(`    ${r.detail}`);
    const found = r.candidates.find((c) => c.key === "real_edge")!;
    console.log(
      `    real_edge: OOS Sharpe ${found.oosSharpe.toFixed(4)}, DSR ${found.dsr.toFixed(4)}, ` +
        `PBO ${found.pbo.toFixed(4)}, p ${found.pValue.toExponential(2)}, verdict ${found.verdict}`,
    );
    assert(found.verdict === "PASS", `the injected true edge is certified PASS (got ${found.verdict})`);
    assert(found.fdrRejected, "…and is FDR-certified against the whole 12-trial family");
    assert(found.vetoes.length === 0, `…with no veto outstanding (${found.vetoes.join("; ")})`);
    assert(r.passes.length === 1, `it is the ONLY pass (${r.passes.length})`);
    assert(
      r.candidates.filter((c) => c.key !== "real_edge").every((c) => c.verdict === "REJECT"),
      "…none of the 11 nulls rode in with it",
    );

    // THE SHADOW SIZE IS NONZERO — the Kelly-cap trap avoided. An edge sized at
    // zero accrues no evidence and could never earn promotion.
    assert(found.shadowSize === 0.001, `a PASS gets a NONZERO shadow size (${found.shadowSize})`);
    assert(found.shadowSize > 0, "…so the edge can actually accrue promotion evidence");

    // ── NOTHING CAN REACH LIVE ───────────────────────────────────────────────
    // Asserted over EVERY candidate including the passing one — a promotion path
    // that stops at REJECT proves nothing about what happens on success.
    for (const c of r.candidates) {
      assert(c.modelVersion.liveAllowed === false, `${c.key}: liveAllowed is false`);
      assert(c.modelVersion.shadowValidated === false, `${c.key}: shadowValidated is false`);
      assert(c.modelVersion.adminApproved === false, `${c.key}: adminApproved is false`);
    }
    assert(
      found.modelVersion.dataValidated && found.modelVersion.walkForwardPassed,
      "the PASS reaches the DATA/WALK_FORWARD stage — and stops there",
    );
    assert(
      JSON.stringify(r).includes('"liveAllowed":false') &&
        !JSON.stringify(r).includes('"liveAllowed":true'),
      "no part of the result serialises liveAllowed as true, anywhere",
    );

    // Determinism.
    const again = runDiscovery({
      spec: SPEC, trials: [edge, ...nulls], validation: REAL_PORT,
      q: 0.1, shadowSize: 0.001, runId: "run_edge",
    });
    assert(again.preregHash === r.preregHash && again.validationReportHash === r.validationReportHash,
      "the same inputs give the same prereg and validation hashes");
  }

  // ── 8c.4 — the guards ──────────────────────────────────────────────────────
  console.log("\n8c Pipeline — guards");
  {
    const trials: TrialOutcome[] = [{
      key: "t0", isNicheSelection: false, params: {},
      oosReturns: Array.from({ length: 600 }, () => 0.001),
    }];

    // A zero shadow size is the Kelly-cap trap and is refused outright.
    throws(
      () => runDiscovery({ spec: SPEC, trials, validation: REAL_PORT, q: 0.1, shadowSize: 0, runId: "x" }),
      "shadowSize = 0 THROWS (an edge that accrues no evidence can never earn promotion)",
    );
    throws(
      () => runDiscovery({ spec: SPEC, trials, validation: REAL_PORT, q: 0.1, shadowSize: -1, runId: "x" }),
      "a negative shadowSize THROWS",
    );

    // The fallback port REFUSES rather than certifying — a missing validator
    // must never be mistaken for a passing one.
    const refused = runDiscovery({
      spec: SPEC, trials, validation: REFUSING_VALIDATION_PORT,
      q: 0.1, shadowSize: 0.001, runId: "x",
    });
    assert(refused.passes.length === 0, "the fallback port certifies NOTHING");
    assert(
      refused.candidates[0]!.vetoes.some((v) => v.includes("NO_VALIDATOR_WIRED")),
      "…and says so explicitly rather than failing silently",
    );
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "discoveryPipelineTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[discoveryPipelineTest] FAILED:", err);
      process.exit(1);
    },
  );
}
