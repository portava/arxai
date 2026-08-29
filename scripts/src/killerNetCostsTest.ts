// Test: the C4 killer test, NET OF COSTS (C7 tie-in).
//
// The original killer test (validationFactoryTest §7e) proves the factory
// certifies ZERO edges on honest driftless V75 GBM. This lane re-runs the
// ENTIRE discovery search — every strategyEngine family, every variant in the
// grid — through the C7 CostSlippageModel netting path, and asserts the same
// zero. Costs only make the bar HIGHER: a substrate with no gross edge cannot
// have a net one, so ANY survivor here means the cost path (or the factory
// behind it) manufactures certifications — CI red, discovery frozen.
//
// Falsifiability is proven both ways:
//   - a planted edge LARGER than its own costs must still certify (the net bar
//     is clearable, so "zero" is a finding, not an artefact of thresholds
//     nothing can pass);
//   - a planted edge SMALLER than its own round-trip costs — a gross
//     "discovery" that a live account would bleed on — must be REJECTED by the
//     net path even though its gross Sharpe is spectacular. That rejection is
//     the entire reason C7 exists.
//
// All randomness is seeded. Pure unit test — no DB, no network, no clock.

import {
  certifyNull,
  generateSyntheticNullBars,
  validateFamily,
  allStrategyVariants,
  strategyReturns,
  FAMILY_KEYS,
  buildCostModel,
  netReturns,
  costEvidence,
  sharpe,
  type TrialResult,
} from "@workspace/validation";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  function assert(cond: boolean, label: string) {
    if (cond) { passes++; console.log(`  ✓ ${label}`); }
    else { failures++; console.error(`  ✗ ${label}`); }
  }

  console.log("killerNetCostsTest");
  console.log("==================\n");

  console.log("THE KILLER TEST, NET — zero certified edges on honest V75 after costs");

  // A DIFFERENT seed from §7e on purpose: passing on one lucky path proves
  // less than passing on two independent ones.
  const { bars, closes } = generateSyntheticNullBars({
    volIndex: 75, bars: 6000, seed: 20260829, subSteps: 12,
  });
  const cert = certifyNull(75, closes);
  assert(cert.ok, `the V75 substrate is certified null before the search — ${cert.detail}`);

  const model = buildCostModel({
    instrument: "Volatility 75 Index",
    instrumentClass: "synthetic",
    venue: "deriv",
  });
  assert(model.spread.provenance === "declared" && model.slippage.provenance === "declared",
    "with no quote/fill history supplied, every cost component is honestly DECLARED, not fake-measured");
  const evidence = costEvidence(model, "positions");
  const cpcv = { nGroups: 6, p: 2, horizon: 5, embargo: 5 };

  const variants = allStrategyVariants();
  assert(variants.length >= 40, `the grid is a real search (${variants.length} variants)`);

  let totalGross = 0;
  let totalNet = 0;
  let perObsHolds = true;
  const trials: TrialResult[] = variants.map((v) => {
    const pos = v.positions(bars);
    const gross = strategyReturns(pos, closes);
    const { net } = netReturns(gross, model, { kind: "positions", positions: pos });
    for (let i = 0; i < gross.length; i++) {
      totalGross += gross[i]!;
      totalNet += net[i]!;
      if (net[i]! > gross[i]! + 1e-15) perObsHolds = false;
    }
    return { key: v.key, familyKey: v.familyKey, returns: net };
  });
  assert(perObsHolds, "net ≤ gross for EVERY observation of EVERY variant — costs only make the bar higher");
  const traded = trials.filter((t) => t.returns.some((r) => r !== 0));
  assert(totalNet < totalGross, `costs were genuinely charged across the search (Σnet ${totalNet.toFixed(2)} < Σgross ${totalGross.toFixed(2)})`);
  const activeFamilies = new Set(traded.map((t) => t.familyKey));
  assert(FAMILY_KEYS.every((f) => activeFamilies.has(f)),
    `every one of the ${FAMILY_KEYS.length} families actually traded — a silent family was never searched`);

  const report = validateFamily("ALL_FAMILIES_V75_NET", trials, { cpcv, pboBlocks: 10, costs: evidence });
  console.log(`    ${report.detail}`);
  const best = [...report.candidates].sort((a, b) => b.dsr - a.dsr)[0]!;
  console.log(`    best candidate: ${best.key} — OOS Sharpe ${best.oosSharpe.toFixed(4)}, DSR ${best.dsr.toFixed(4)}, PBO ${best.pbo.toFixed(4)}`);

  assert(report.survivors.length === 0,
    `ZERO edges certified on honest V75 through the NET path (${report.survivors.length} survivors — any survivor means the cost path manufactures certifications)`);
  assert(report.candidates.every((c) => c.vetoes.length > 0), "every candidate was vetoed");
  assert(report.costs !== null && report.costs.modelHash === model.modelHash,
    "the report certifies (nothing) under the exact cost model used to net the returns");

  // ── Falsifiability, both directions ────────────────────────────────────────
  console.log("\nThe net bar is clearable — and it kills what only LOOKS clearable");
  {
    const n = trials[0]!.returns.length;
    const flat = (perBar: number) =>
      netReturns(
        Array.from({ length: n }, (_, i) => perBar + (i % 7) * 1e-6),
        model,
        { kind: "positions", positions: new Array<number>(n).fill(1) },
      ).net;

    // Big edge: well above its own costs — must survive the net bar.
    const bigEdge: TrialResult = { key: "PLANTED_BIG_EDGE", familyKey: "PlantedEdge", returns: flat(0.004) };
    const withBig = validateFamily("V75_NET_PLUS_BIG", [bigEdge, ...trials], { cpcv, pboBlocks: 10, costs: evidence });
    const big = withBig.candidates.find((c) => c.key === "PLANTED_BIG_EDGE")!;
    assert(big.verdict === "PASS",
      `an edge larger than its costs still certifies NET (${big.verdict}) — zero is a finding, not an artefact`);
    assert(withBig.survivors.length === 1 && withBig.survivors[0]!.key === "PLANTED_BIG_EDGE",
      "…and it is the ONLY survivor");

    // Cost-eaten edge: gross mean is a fraction of one observation's round-trip
    // charge under the conservative per-observation schedule — spectacular
    // gross Sharpe, guaranteed real-world bleed. The net path must kill it.
    const perObsCharge = 2 * model.perSideCostFrac; // round trip per obs
    const tinyGross = Array.from({ length: n }, (_, i) => perObsCharge * 0.3 + (i % 7) * 1e-7);
    assert(sharpe(tinyGross) > 3, `the cost-eaten edge is spectacular GROSS (per-obs Sharpe ${sharpe(tinyGross).toFixed(2)})`);
    const tinyNet = netReturns(tinyGross, model, { kind: "roundTripPerObservation", size: 1 }).net;
    const tiny: TrialResult = { key: "COST_EATEN_EDGE", familyKey: "PlantedEdge", returns: tinyNet };
    const withTiny = validateFamily("V75_NET_PLUS_TINY", [tiny, ...trials], { cpcv, pboBlocks: 10, costs: evidence });
    const eaten = withTiny.candidates.find((c) => c.key === "COST_EATEN_EDGE")!;
    assert(eaten.verdict === "REJECT",
      `an edge smaller than its own round-trip cost is REJECTED net (${eaten.verdict}) — the exact lie C7 exists to catch`);
    assert(eaten.oosSharpe < 0, `…because net of costs it LOSES (net OOS Sharpe ${eaten.oosSharpe.toFixed(4)})`);
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "killerNetCostsTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[killerNetCostsTest] FAILED:", err);
      process.exit(1);
    },
  );
}
