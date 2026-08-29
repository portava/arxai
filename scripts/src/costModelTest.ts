// Test: C7 CostSlippageModel (@workspace/validation costModel).
//
// The properties that matter, each with a way to FAIL:
//
//   1. PROVENANCE HONESTY — a declared default is never presented as measured;
//      an under-powered sample falls back to declared AND says so; a real
//      sample flips the stamp to measured.
//   2. CONSERVATISM — slippage is adverse-only (favorable fills count 0, the
//      mean can never go negative); an unknown venue pays the most expensive
//      declared commission; net ≤ gross for EVERY observation under EVERY
//      schedule (property-tested over seeded random inputs).
//   3. THE FACTORY REFUSES GROSS — validateFamily without cost evidence vetoes
//      every candidate with NET_OF_COSTS_REQUIRED and certifies nothing, even
//      a blatant planted edge (the mutation proof: the same edge WITH evidence
//      certifies, so the veto is what stands between gross and certified).
//   4. HOLLOW EVIDENCE REFUSED — applied:false, a zero per-side cost, or a
//      malformed model hash are all gross-in-disguise and are vetoed.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import {
  buildCostModel,
  estimateSpread,
  estimateSlippage,
  commissionForVenue,
  netReturns,
  costEvidence,
  validateFamily,
  seeded,
  gaussian,
  MIN_QUOTE_SAMPLE,
  MIN_FILL_SAMPLE,
  DECLARED_CLASS_DEFAULTS,
  DECLARED_VENUE_COMMISSION_PER_SIDE,
  UNKNOWN_VENUE_COMMISSION_PER_SIDE,
  type QuoteObservation,
  type DemoFillObservation,
  type TrialResult,
  type CostEvidence,
} from "@workspace/validation";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

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
  function near(a: number, b: number, tol: number, label: string) {
    assert(Number.isFinite(a) && Math.abs(a - b) <= tol, `${label} (got ${a}, expected ${b} ±${tol})`);
  }

  console.log("costModelTest");
  console.log("=============\n");

  // ── 1. Provenance honesty ──────────────────────────────────────────────────
  console.log("Provenance: declared is never dressed up as measured");
  {
    const noQuotes = estimateSpread("synthetic", []);
    assert(noQuotes.provenance === "declared", "no quotes ⇒ declared");
    assert(noQuotes.frac === DECLARED_CLASS_DEFAULTS.synthetic.halfSpreadFrac,
      "…at exactly the declared class default");

    const few: QuoteObservation[] = Array.from({ length: MIN_QUOTE_SAMPLE - 1 }, () => ({ bid: 99, ask: 101 }));
    assert(estimateSpread("synthetic", few).provenance === "declared",
      `${MIN_QUOTE_SAMPLE - 1} quotes is under-powered ⇒ still declared, not measured`);

    const enough: QuoteObservation[] = Array.from({ length: MIN_QUOTE_SAMPLE }, () => ({ bid: 99, ask: 101 }));
    const measured = estimateSpread("synthetic", enough);
    assert(measured.provenance === "measured", `${MIN_QUOTE_SAMPLE} quotes ⇒ measured`);
    near(measured.frac, 2 / 200, 1e-12, "measured relative half-spread = (ask−bid)/(2·mid)");
    assert(measured.n === MIN_QUOTE_SAMPLE, "the sample size is recorded");

    // Malformed quotes are dropped, not repaired.
    const crossed: QuoteObservation[] = Array.from({ length: MIN_QUOTE_SAMPLE }, () => ({ bid: 101, ask: 99 }));
    assert(estimateSpread("synthetic", crossed).provenance === "declared",
      "a sample of crossed quotes is unusable ⇒ declared (repairing a quote would be fabricating one)");

    const fewFills: DemoFillObservation[] = Array.from({ length: MIN_FILL_SAMPLE - 1 }, () => ({
      requestedPrice: 100, filledPrice: 100.1,
    }));
    assert(estimateSlippage("synthetic", fewFills).provenance === "declared",
      "an under-powered fill sample ⇒ declared slippage");
  }

  // ── 2. Slippage is adverse-only ────────────────────────────────────────────
  console.log("\nSlippage: measured from fills, favorable fills never subsidise");
  {
    const fills: DemoFillObservation[] = Array.from({ length: MIN_FILL_SAMPLE }, (_, i) => ({
      requestedPrice: 100,
      filledPrice: i % 2 === 0 ? 100.2 : 99.8, // half adverse, half favorable
    }));
    const s = estimateSlippage("synthetic", fills);
    assert(s.provenance === "measured", "a sufficient fill sample measures");
    near(s.frac, 0.001, 1e-9,
      "favorable fills clamp to 0 — the mean is over max(0, slip), not the signed mean (which would be 0)");

    const allFavorable: DemoFillObservation[] = Array.from({ length: MIN_FILL_SAMPLE }, () => ({
      requestedPrice: 100, filledPrice: 99.5,
    }));
    const f = estimateSlippage("synthetic", allFavorable);
    assert(f.frac === 0 && f.provenance === "measured",
      "uniformly favorable fills measure 0 — never a negative cost, never a rebate");
  }

  // ── 3. Commission: unknown venue pays the most ─────────────────────────────
  console.log("\nCommission: declared per venue; unknown venue never rides free");
  {
    assert(commissionForVenue("deriv").frac === DECLARED_VENUE_COMMISSION_PER_SIDE.deriv,
      "deriv gets its declared schedule");
    assert(commissionForVenue("deriv").provenance === "declared", "…stamped declared");
    const unknown = commissionForVenue("some-new-venue");
    assert(unknown.frac === UNKNOWN_VENUE_COMMISSION_PER_SIDE, "unknown venue pays the conservative default");
    assert(
      Object.values(DECLARED_VENUE_COMMISSION_PER_SIDE).every((v) => v <= UNKNOWN_VENUE_COMMISSION_PER_SIDE),
      "…which is ≥ every declared venue (never the cheap way out)",
    );
  }

  // ── 4. netReturns arithmetic + the net ≤ gross property ────────────────────
  console.log("\nnetReturns: only ever subtracts");
  {
    const model = buildCostModel({ instrument: "Volatility 75 Index", instrumentClass: "synthetic", venue: "deriv" });
    assert(/^[0-9a-f]{64}$/.test(model.modelHash), "the model carries a sha256 hash");
    const again = buildCostModel({ instrument: "Volatility 75 Index", instrumentClass: "synthetic", venue: "deriv" });
    assert(again.modelHash === model.modelHash, "…and the same inputs give the same hash");
    near(model.perSideCostFrac,
      DECLARED_CLASS_DEFAULTS.synthetic.halfSpreadFrac +
        DECLARED_CLASS_DEFAULTS.synthetic.perSideSlippageFrac +
        DECLARED_VENUE_COMMISSION_PER_SIDE.deriv!,
      1e-12, "per-side cost = spread + slippage + commission");

    // Exact charge accounting on a hand-checkable path: flat → long → flat.
    const gross = [0.01, 0.01, 0.01];
    const { net, totalCostCharged } = netReturns(gross, model, { kind: "positions", positions: [1, 1, 0] });
    const c = model.perSideCostFrac;
    near(net[0]!, 0.01 - c, 1e-12, "entry pays one side on the size change");
    near(net[1]!, 0.01, 1e-12, "holding pays nothing");
    near(net[2]!, 0.01 - c, 1e-12, "the exit to flat pays one side (and the final flat position owes no unwind)");
    near(totalCostCharged, 2 * c, 1e-12, "total = one full round trip");

    // A position still open at the end owes its unwind on the last observation.
    const open = netReturns(gross, model, { kind: "positions", positions: [1, 1, 1] });
    near(open.net[2]!, 0.01 - c, 1e-12, "an open final position is charged its own unwind — holding forever is not a cost loophole");

    const rt = netReturns(gross, model, { kind: "roundTripPerObservation", size: 1 });
    assert(rt.net.every((n, i) => Math.abs(n - (gross[i]! - 2 * c)) < 1e-12),
      "roundTripPerObservation charges a full round trip on every observation (the conservative upper bound)");

    // PROPERTY: net ≤ gross for every observation, seeded-random inputs.
    const g = gaussian(seeded(7101));
    let holds = true;
    for (let trial = 0; trial < 50; trial++) {
      const n = 40;
      const gr = Array.from({ length: n }, () => g() * 0.01);
      const pos = Array.from({ length: n }, () => Math.round(g() * 2) / 2);
      const r1 = netReturns(gr, model, { kind: "positions", positions: pos });
      const r2 = netReturns(gr, model, { kind: "roundTripPerObservation", size: 0.5 });
      if (r1.net.some((v, i) => v > gr[i]! + 1e-15)) holds = false;
      if (r2.net.some((v, i) => v >= gr[i]!)) holds = false;
      if (r1.totalCostCharged < 0 || r2.totalCostCharged <= 0) holds = false;
    }
    assert(holds, "PROPERTY over 50 seeded cases: net ≤ gross always; charges never negative");

    throws(() => netReturns([0.01, NaN], model, { kind: "roundTripPerObservation", size: 1 }),
      "a non-finite gross return throws — netting fabricated inputs would launder them");
    throws(() => netReturns(gross, model, { kind: "positions", positions: [1] }),
      "a positions schedule shorter than the return series throws — exposure must be declared, not assumed");
    throws(() => netReturns(gross, model, { kind: "roundTripPerObservation", size: 0 }),
      "a zero size throws");
    throws(() => costEvidence({ ...model, perSideCostFrac: 0 }, "positions"),
      "evidence for a zero-cost model refuses to exist");
  }

  // ── 5. The factory REQUIRES net-of-costs evaluation ────────────────────────
  console.log("\nFactory: a gross-only certification is impossible");
  {
    const model = buildCostModel({ instrument: "Volatility 75 Index", instrumentClass: "synthetic", venue: "deriv" });
    // A blatant edge that would sail through every statistical veto.
    const edge: TrialResult[] = [{
      key: "BLATANT_EDGE",
      familyKey: "fam",
      returns: Array.from({ length: 600 }, (_, i) => 0.004 + (i % 7) * 1e-5),
    }, {
      key: "OTHER",
      familyKey: "fam",
      returns: (() => { const g = gaussian(seeded(9)); return Array.from({ length: 600 }, () => g() * 0.01); })(),
    }];
    const cpcv = { nGroups: 6, p: 2, horizon: 5, embargo: 5 };

    const grossReport = validateFamily("fam", edge, { cpcv, pboBlocks: 10 });
    assert(grossReport.survivors.length === 0,
      "WITHOUT cost evidence, even a blatant edge certifies NOTHING");
    assert(grossReport.candidates.every((c) => c.vetoes.some((v) => v.startsWith("NET_OF_COSTS_REQUIRED"))),
      "…every candidate carries the explicit NET_OF_COSTS_REQUIRED veto");
    assert(grossReport.costs === null, "…and the report says it was gross-only");

    // MUTATION PROOF the other way: the SAME returns netted + evidenced DO pass,
    // so the veto above is the only thing standing between gross and certified.
    const netted: TrialResult[] = edge.map((t) => ({
      ...t,
      returns: netReturns(t.returns, model, {
        kind: "positions",
        positions: new Array<number>(t.returns.length).fill(1),
      }).net,
    }));
    const netReport = validateFamily("fam", netted, { cpcv, pboBlocks: 10, costs: costEvidence(model, "positions") });
    assert(netReport.survivors.length === 1 && netReport.survivors[0]!.key === "BLATANT_EDGE",
      "WITH netting + evidence the same edge certifies — the bar is clearable, so the gross refusal is a refusal, not a broken gate");
    assert(netReport.costs !== null && netReport.costs.modelHash === model.modelHash,
      "…and the report carries the cost evidence it certified under");

    // Hollow evidence is gross in disguise — all three disguises are vetoed.
    const good = costEvidence(model, "positions");
    const hollow: Array<[string, CostEvidence]> = [
      ["applied:false", { ...good, applied: false as unknown as true }],
      ["zero per-side cost", { ...good, perSideCostFrac: 0 }],
      ["malformed model hash", { ...good, modelHash: "beef" }],
    ];
    for (const [label, ev] of hollow) {
      const r = validateFamily("fam", netted, { cpcv, pboBlocks: 10, costs: ev });
      assert(
        r.survivors.length === 0 &&
          r.candidates.every((c) => c.vetoes.some((v) => v.startsWith("NET_OF_COSTS_REQUIRED"))),
        `hollow evidence (${label}) is vetoed like no evidence at all`,
      );
    }
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "costModelTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[costModelTest] FAILED:", err);
      process.exit(1);
    },
  );
}
