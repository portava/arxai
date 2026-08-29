// Test: C8 TransferProofHarness (@workspace/validation transferProof).
//
// The machinery is data-agnostic and every test here exercises MACHINERY with
// labelled fixture inputs — the turn-of-month experiment itself is registered
// but never evaluated, because its data is not provisioned and NOTHING may
// substitute synthetic data for it (section 6 pins exactly that).
//
// What must hold, each with a way to fail:
//   1. PRE-REGISTRATION IS THE ONLY DOOR — evaluation refuses without a locked
//      spec; a spec that mutated after locking is refused BY HASH; the
//      registration row precedes every evaluation row in the chain.
//   2. FIT/LOCK/OOS — evaluation data overlapping the fit window is refused.
//   3. NET ONLY — gross evaluation (no/hollow cost evidence) is refused.
//   4. THE VERDICT IS AN AND — every pre-registered clause must pass; a MISS
//      retires the experiment, emits an FDR charge consumable by
//      lib/discovery's controlFdr, and the same spec can never respin on the
//      same data (new data requires an explicit declaration).
//   5. THE CHAIN IS REAL — rows verify under @workspace/features
//      verifyChainRows (byte-level canonicalization parity), and a tampered
//      row breaks it.
//   6. TURN-OF-MONTH stays honestly BLOCKED_ON_DATA with a typed owner-owned
//      reason.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import {
  TransferProofHarness,
  specHashOf,
  isRefusal,
  registerTurnOfMonthExperiment,
  TURN_OF_MONTH_SPEC,
  transferSharpePValue,
  buildCostModel,
  costEvidence,
  seeded,
  gaussian,
  type ExperimentSpec,
  type TransferEvaluationInput,
} from "@workspace/validation";
import { controlFdr, sharpePValue } from "@workspace/discovery";
import { verifyChainRows, computeRowHash } from "@workspace/features";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

// A fixture experiment for exercising the MACHINERY. Not a claim about any
// market; the returns fed below are labelled fixtures.
const FIXTURE_SPEC: ExperimentSpec = {
  experimentKey: "MACHINERY_FIXTURE_V1",
  instrument: "FIXTURE",
  instrumentClass: "index",
  calendarRule: "FIXTURE: every observation",
  entryOffsetDays: 0,
  exitOffsetDays: 1,
  size: 1,
  fitWindow: { start: "2010-01-01", end: "2014-12-31" },
  holdoutWindow: { start: "2015-01-01", end: "2019-12-31" },
  passBar: { minNetDsr: 0.95, maxPbo: 0.2, minNetSharpe: 0.5, minShadowObservations: 6 },
};

const COST_MODEL = buildCostModel({ instrument: "FIXTURE", instrumentClass: "index", venue: "fixture-venue" });
const COSTS = costEvidence(COST_MODEL, "positions");

function goodEvaluation(overrides?: Partial<TransferEvaluationInput>): TransferEvaluationInput {
  const g = gaussian(seeded(20260829));
  // A strong fixture edge: enough to clear DSR 0.95 and Sharpe 0.5 per-obs.
  const rets = Array.from({ length: 400 }, () => 0.006 + g() * 0.008);
  // A selection field where the registered variant genuinely dominates, so PBO
  // is measurable and low.
  const field = [rets, ...Array.from({ length: 5 }, () => Array.from({ length: 400 }, () => g() * 0.008))];
  return {
    at: "2026-08-29T00:00:00Z",
    netOosReturns: rets,
    costs: COSTS,
    dataWindow: { start: "2015-01-01", end: "2019-12-31" },
    dataFingerprint: "fixture-data-v1",
    nTrials: 1,
    selectionField: field,
    pboBlocks: 10,
    ...overrides,
  };
}

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  function assert(cond: boolean, label: string) {
    if (cond) { passes++; console.log(`  ✓ ${label}`); }
    else { failures++; console.error(`  ✗ ${label}`); }
  }

  console.log("transferProofTest");
  console.log("=================\n");

  // ── 1. Pre-registration is the only door ───────────────────────────────────
  console.log("Pre-registration discipline");
  {
    const h = new TransferProofHarness();

    // Evaluation with no registration refuses.
    const unregistered = h.evaluate(FIXTURE_SPEC, goodEvaluation());
    assert(isRefusal(unregistered) && unregistered.code === "NOT_REGISTERED",
      "evaluation REFUSES to run without a pre-registered locked spec");

    const reg = h.register(FIXTURE_SPEC, "2026-08-29T00:00:00Z");
    assert(!isRefusal(reg), "a valid spec registers");
    if (isRefusal(reg)) throw new Error(reg.detail);
    assert(/^[0-9a-f]{64}$/.test(reg.specHash), "the spec hash is a sha256");
    assert(reg.specHash === specHashOf(FIXTURE_SPEC), "…computed over the spec alone");
    assert(reg.chainRow.fields.type === "PREREGISTRATION", "registration lands in the chain");

    const dup = h.register(FIXTURE_SPEC, "2026-08-29T00:00:01Z");
    assert(isRefusal(dup) && dup.code === "ALREADY_REGISTERED", "double registration refuses");

    // A MUTATED spec — one parameter nudged after locking — refuses by hash.
    const mutated = h.evaluate({ ...FIXTURE_SPEC, exitOffsetDays: 2 }, goodEvaluation());
    assert(isRefusal(mutated) && mutated.code === "SPEC_HASH_MUTATED",
      "a spec that changed after pre-registration is refused BY HASH — 'we always meant exit T+2' is unhearable");
    const mutatedBar = h.evaluate(
      { ...FIXTURE_SPEC, passBar: { ...FIXTURE_SPEC.passBar, minNetSharpe: 0.1 } },
      goodEvaluation(),
    );
    assert(isRefusal(mutatedBar) && mutatedBar.code === "SPEC_HASH_MUTATED",
      "…and the PASS BAR is inside the hash — the bar cannot be lowered after the fact");

    // Self-inconsistent specs never register.
    const overlapping = h.register(
      { ...FIXTURE_SPEC, experimentKey: "BAD", holdoutWindow: { start: "2014-01-01", end: "2019-12-31" } },
      "t",
    );
    assert(isRefusal(overlapping) && overlapping.code === "INVALID_SPEC",
      "a holdout that overlaps the fit window is refused at registration");
  }

  // ── 2 + 3. Fit-overlap and gross-only refusals ─────────────────────────────
  console.log("\nEvaluation refusals: fit overlap, gross-only");
  {
    const h = new TransferProofHarness();
    h.register(FIXTURE_SPEC, "t0");

    const overlap = h.evaluate(FIXTURE_SPEC, goodEvaluation({
      dataWindow: { start: "2014-06-01", end: "2019-12-31" },
    }));
    assert(isRefusal(overlap) && overlap.code === "FIT_WINDOW_OVERLAP",
      "evaluation data overlapping the fit window is refused — fitted data cannot also prove");

    const gross = h.evaluate(FIXTURE_SPEC, goodEvaluation({
      costs: { ...COSTS, perSideCostFrac: 0 },
    }));
    assert(isRefusal(gross) && gross.code === "GROSS_ONLY",
      "a zero-cost evaluation is refused — the pass bar is NET");

    const noFp = h.evaluate(FIXTURE_SPEC, goodEvaluation({ dataFingerprint: "" }));
    assert(isRefusal(noFp) && noFp.code === "INVALID_INPUT",
      "data without an identity is refused — the no-respin rule needs a fingerprint");
  }

  // ── 4a. The full PASS path ─────────────────────────────────────────────────
  console.log("\nVerdict: PASS only when EVERY pre-registered clause passes");
  {
    const h = new TransferProofHarness();
    const reg = h.register(FIXTURE_SPEC, "t0");
    if (isRefusal(reg)) throw new Error(reg.detail);

    const ev = h.evaluate(FIXTURE_SPEC, goodEvaluation());
    assert(!isRefusal(ev), "a clean net OOS evaluation runs");

    // Verdict before shadow evidence: the SHADOW_CI clause fails ⇒ MISS. So
    // first prove the shadow gate actually gates, on a THROWAWAY harness.
    {
      const h2 = new TransferProofHarness();
      h2.register(FIXTURE_SPEC, "t0");
      h2.evaluate(FIXTURE_SPEC, goodEvaluation());
      const v = h2.verdict(specHashOf(FIXTURE_SPEC), "t1");
      assert(!isRefusal(v) && v.verdict === "MISS" &&
        v.clauses.find((c) => c.clause === "SHADOW_CI")!.pass === false,
        "without shadow observations the SHADOW_CI clause fails and the verdict is MISS — statistics alone cannot pass");
    }

    // Accrue a positive shadow record, then the verdict passes every clause.
    const g = gaussian(seeded(11));
    for (let i = 0; i < 12; i++) {
      const r = h.recordShadowPnl(reg.specHash, 0.01 + g() * 0.005, `t${i}`);
      assert2Silent(r);
    }
    const verdict = h.verdict(reg.specHash, "t99");
    if (isRefusal(verdict)) throw new Error(verdict.detail);
    console.log(`    clauses: ${verdict.clauses.map((c) => `${c.clause}=${c.pass}`).join(", ")}`);
    assert(verdict.verdict === "PASS", "with every clause green the verdict is PASS");
    assert(verdict.clauses.length === 4 && verdict.clauses.every((c) => c.pass),
      "…all four pre-registered clauses individually pass");
    assert(verdict.fdrCharge === null, "a PASS charges nothing to the FDR family");
    assert(h.get(reg.specHash)!.status === "PASSED", "the record is terminal PASSED");

    const restate = h.verdict(reg.specHash, "t100");
    assert(!isRefusal(restate) && restate === verdict, "a verdict does not restate — asking again returns the same verdict");
  }

  // ── 4b. MISS ⇒ retirement + FDR charge + no respin ─────────────────────────
  console.log("\nMISS: retirement, FDR charge, no respin on the same data");
  {
    const h = new TransferProofHarness();
    const reg = h.register(FIXTURE_SPEC, "t0");
    if (isRefusal(reg)) throw new Error(reg.detail);

    // A fixture with NO edge: net returns centred below zero.
    const g = gaussian(seeded(404));
    const flat = Array.from({ length: 400 }, () => -0.0005 + g() * 0.008);
    h.evaluate(FIXTURE_SPEC, goodEvaluation({ netOosReturns: flat, selectionField: undefined }));
    for (let i = 0; i < 12; i++) h.recordShadowPnl(reg.specHash, g() * 0.005, `t${i}`);

    const verdict = h.verdict(reg.specHash, "t99");
    if (isRefusal(verdict)) throw new Error(verdict.detail);
    assert(verdict.verdict === "MISS", "a no-edge fixture MISSES");
    assert(verdict.clauses.find((c) => c.clause === "PBO")!.pass === false,
      "…and an absent selection field makes PBO UNMEASURABLE, which FAILS the clause (unmeasurable ≠ low)");
    assert(h.get(reg.specHash)!.status === "RETIRED", "the experiment is RETIRED");

    // The FDR charge is structurally lib/discovery's FdrTest and feeds
    // controlFdr directly — choosing this niche was itself a trial.
    const charge = verdict.fdrCharge!;
    assert(charge !== null && charge.p > 0 && charge.p <= 1, "a MISS emits an FDR charge with a real p-value");
    const fdr = controlFdr([charge], 0.1, 5);
    assert(fdr.familySize === 5 && fdr.decisions.length === 1,
      "…consumable by @workspace/discovery controlFdr as one trial of the wider family");
    const netSharpeObserved = h.get(reg.specHash)!.evaluation!.netSharpe;
    assert(Math.abs(transferSharpePValue(netSharpeObserved, 400) - sharpePValue(netSharpeObserved, 400)) < 1e-12,
      "the harness's p-value matches lib/discovery's sharpePValue exactly (duplicated, pinned here)");

    // Terminal means terminal.
    const again = h.evaluate(FIXTURE_SPEC, goodEvaluation({ netOosReturns: flat }));
    assert(isRefusal(again) && again.code === "ALREADY_RETIRED", "a retired experiment cannot be re-evaluated");
    const reReg = h.register(FIXTURE_SPEC, "t100");
    assert(isRefusal(reReg) && reReg.code === "NO_RESPIN_ON_SAME_DATA",
      "re-registration of a retired spec refuses without a NEW-data declaration");
    const sameData = h.register(FIXTURE_SPEC, "t101", { newDataFingerprint: "fixture-data-v1" });
    assert(isRefusal(sameData) && sameData.code === "NO_RESPIN_ON_SAME_DATA",
      "…and declaring the SAME data it missed on is exactly the respin that is refused");
    const newData = h.register(FIXTURE_SPEC, "t102", { newDataFingerprint: "genuinely-new-data-v2" });
    assert(!isRefusal(newData), "genuinely new data may re-register (the hypothesis is not banned, the respin is)");
    if (!isRefusal(newData)) {
      const respin = h.evaluate(FIXTURE_SPEC, goodEvaluation({ netOosReturns: flat, dataFingerprint: "fixture-data-v1" }));
      assert(isRefusal(respin) && respin.code === "NO_RESPIN_ON_SAME_DATA",
        "…but evaluating the re-registered spec against the OLD data is still refused — the memory is permanent");
    }
  }

  // ── 5. The chain is real, and features-parity ──────────────────────────────
  console.log("\nChain: verifiable by @workspace/features, tamper-evident");
  {
    const h = new TransferProofHarness();
    const reg = h.register(FIXTURE_SPEC, "t0");
    if (isRefusal(reg)) throw new Error(reg.detail);
    h.evaluate(FIXTURE_SPEC, goodEvaluation());
    h.recordShadowPnl(reg.specHash, 0.01, "t1");

    const rows = [...h.chain()];
    assert(rows.length === 3, `three actions ⇒ three chain rows (got ${rows.length})`);
    assert(rows[0]!.fields.type === "PREREGISTRATION" && rows[1]!.fields.type === "EVALUATION",
      "the REGISTRATION row precedes the EVALUATION row — the order is in the chain, not in trust");

    // Byte-level parity: features' canonicaliser recomputes our hashes.
    assert(rows.every((r) => computeRowHash(r.fields, r.prevHash) === r.rowHash),
      "every row hash recomputes under @workspace/features computeRowHash — same canonical bytes");
    const v = verifyChainRows(rows);
    assert(v.valid, "the chain verifies under @workspace/features verifyChainRows");

    const tampered = rows.map((r, i) =>
      i === 1 ? { ...r, fields: { ...r.fields, netSharpe: 9.99 } } : r,
    );
    const broken = verifyChainRows(tampered);
    assert(!broken.valid && broken.firstBreakIndex === 1 && broken.reason === "CHECKSUM_MISMATCH",
      "editing an evaluation result after the fact breaks the chain at that row");
  }

  // ── 6. Turn-of-month: registered, honestly BLOCKED_ON_DATA ─────────────────
  console.log("\nTurn-of-month: pre-registered, evaluation honestly blocked");
  {
    const h = new TransferProofHarness();
    const reg = registerTurnOfMonthExperiment(h, "2026-08-29T00:00:00Z");
    assert(!isRefusal(reg), "the turn-of-month experiment registers");
    if (isRefusal(reg)) throw new Error(reg.detail);

    assert(reg.record.status === "BLOCKED_ON_DATA", "its status is BLOCKED_ON_DATA");
    assert(reg.record.blocked!.code === "DATA_NOT_PROVISIONED", "…with the typed reason DATA_NOT_PROVISIONED");
    assert(reg.record.blocked!.decisionOwner === "OWNER", "…and the unblock is explicitly an OWNER decision");
    assert(reg.record.blocked!.missing.includes("equity-index daily closes"),
      "…naming exactly what is missing: equity-index daily closes");
    assert(reg.record.evaluation === null, "NO evaluation exists — no data was fabricated to make one");

    const v = h.verdict(reg.specHash, "t1");
    assert(isRefusal(v) && v.code === "BLOCKED_ON_DATA",
      "asking for a verdict refuses with the typed blocked reason, not a guess");

    // The plan's parameters, locked into the hash.
    assert(TURN_OF_MONTH_SPEC.entryOffsetDays === -1 && TURN_OF_MONTH_SPEC.exitOffsetDays === 3,
      "the spec locks close of T−1 → close of T+3");
    assert(TURN_OF_MONTH_SPEC.fitWindow.start === "2005-01-01" && TURN_OF_MONTH_SPEC.fitWindow.end === "2015-12-31",
      "fit 2005–2015");
    assert(TURN_OF_MONTH_SPEC.holdoutWindow.start === "2016-01-01" && TURN_OF_MONTH_SPEC.holdoutWindow.end === "2025-12-31",
      "holdout 2016–2025, fully OOS");
    assert(TURN_OF_MONTH_SPEC.passBar.minNetDsr === 0.95 && TURN_OF_MONTH_SPEC.passBar.maxPbo === 0.2 &&
      TURN_OF_MONTH_SPEC.passBar.minNetSharpe === 0.5,
      "the pre-registered pass bar: net DSR at 5%, PBO < 0.2, net Sharpe ≥ 0.5");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "transferProofTest", passes, failures };

  function assert2Silent(r: unknown) {
    if (isRefusal(r)) { failures++; console.error(`  ✗ shadow record refused: ${r.detail}`); }
  }
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[transferProofTest] FAILED:", err);
      process.exit(1);
    },
  );
}
