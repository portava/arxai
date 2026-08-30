// C8 turn-of-month wiring — the trade generator and its path into the harness.
//
// What must hold, each with a way to fail:
//   1. THE PRE-REGISTERED RULE IS WHAT THE CODE DOES. On a REAL NYSE session
//      calendar, the generator's entries and exits are asserted against
//      hand-written literal dates: enter at the close of the last session of
//      the previous month, exit at the close of the fourth session of the new
//      one. Offsets are TRADING days, so a fixture that spans a holiday and a
//      weekend is the test that would catch a calendar-day reading.
//   2. NO LEAK AT THE WINDOW SEAM. A boundary whose entry bar falls outside the
//      window is SKIPPED LOUDLY with a typed reason, and the reported data
//      window is derived from the bars actually READ.
//   3. THE HARNESS STILL REFUSES. No locked spec ⇒ NOT_REGISTERED. A spec that
//      mutated after locking ⇒ SPEC_HASH_MUTATED. Fit-window data ⇒
//      FIT_WINDOW_OVERLAP. Zero-cost ⇒ GROSS_ONLY. This wiring cannot talk its
//      way past any of them.
//   4. THE PRE-REGISTRATION LOCK survives across processes: the spec's hash is
//      pinned as a literal, so editing the spec breaks the check rather than
//      silently re-locking.
//   5. COSTS ONLY SUBTRACT, and the fingerprint covers exactly the bars used.
//   6. THE SELECTION FIELD is rectangular and contains the pre-registered
//      variant — PBO against a field the search never held is a fiction.
//   7. PBO IS DECIDED BEFORE THE HOLDOUT IS READ. The harness computes it from
//      the fit-stage selection field alone, so inverting every out-of-sample
//      return moves it not at all. That makes it the SECOND clause (after
//      SHADOW_CI) that can be known-failed in advance, and a runbook followed
//      end-to-end would spend the one shot and charge FDR on a foregone MISS.
//      Asserted directly, because the owner-press script's pre-flight guard is
//      only worth having if this property is actually true.
//   8. THE NO-RESPIN MEMORY IS NOT IN THE HARNESS. A second `TransferProofHarness`
//      re-registers a spec the first one retired — that is asserted here as the
//      fact it is, not assumed away — so the durable half lives in the one-shot
//      ledger file, whose parse/match rules are covered here too.
//
// Offline, deterministic, no clock. Nothing here evaluates the real holdout.
//
// Run: pnpm --filter @workspace/scripts run test:c8-turn-of-month

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECLARED_FIT_VARIANT_GRID,
  TURN_OF_MONTH_LOCKED_SPEC_HASH,
  TURN_OF_MONTH_SPEC,
  TransferProofHarness,
  buildCostModel,
  buildFitSelectionField,
  buildTurnOfMonthEvaluationInput,
  estimatePbo,
  generateTurnOfMonthTrades,
  isRefusal,
  isTurnOfMonthBuildRefusal,
  monthBoundaryIndices,
  pboPreflight,
  PBO_PREFLIGHT_BLOCKS,
  specHashOf,
  verifyTurnOfMonthPreRegistration,
  type ExperimentSpec,
} from "@workspace/validation";
import { dataFingerprint, expectedTradingDays, isCalendarSpanRefusal, type DailyBar } from "@workspace/markets";
import {
  VERDICT_LEDGER_FORMAT,
  describeLedgerEntry,
  findSpentShot,
  parseVerdictLedger,
  serialiseLedgerEntry,
  type VerdictLedgerEntry,
} from "../c8VerdictLedger.js";

const AT = "2026-08-29T00:00:00.000Z";

/**
 * Real NYSE session dates with a deterministic, non-random price path. The
 * prices are a fixture; the DATES are the real calendar, which is the part the
 * trade generator's correctness depends on.
 */
function fixtureBars(from: string, to: string): DailyBar[] {
  const days = expectedTradingDays(from, to);
  assert.ok(!isCalendarSpanRefusal(days));
  return (days as string[]).map((d, i) => ({ date: d, close: 100 + Math.sin(i / 7) * 3 + i * 0.02 }));
}

const COST_MODEL = buildCostModel({
  instrument: TURN_OF_MONTH_SPEC.instrument,
  instrumentClass: TURN_OF_MONTH_SPEC.instrumentClass,
  venue: "test-venue",
});

// ── 1. the pre-registered rule ───────────────────────────────────────────────

test("the generator produces the PRE-REGISTERED entries and exits on a real session calendar", () => {
  const bars = fixtureBars("2015-01-02", "2015-04-30");
  const gen = generateTurnOfMonthTrades(bars, {
    entryOffsetDays: TURN_OF_MONTH_SPEC.entryOffsetDays, // −1
    exitOffsetDays: TURN_OF_MONTH_SPEC.exitOffsetDays, //  +3
    size: TURN_OF_MONTH_SPEC.size,
    window: { start: "2015-01-02", end: "2015-04-30" },
  });

  // Hand-checked against the 2015 NYSE calendar:
  //   Feb boundary: 2015-02-01 is a Sunday, so T = Mon 2015-02-02.
  //                 T−1 = Fri 2015-01-30 (last session of January).
  //                 T+3 = Thu 2015-02-05 (fourth session of February).
  //   Mar boundary: 2015-03-01 is a Sunday, so T = Mon 2015-03-02.
  //                 T−1 = Fri 2015-02-27, T+3 = Thu 2015-03-05.
  //   Apr boundary: T = Wed 2015-04-01, T−1 = Tue 2015-03-31.
  //                 April's sessions run 1st, 2nd, then 6th — Fri 2015-04-03
  //                 was GOOD FRIDAY and Sat/Sun follow it — so counting THREE
  //                 TRADING DAYS from T gives 1st→2nd→6th→7th and T+3 is
  //                 Tue 2015-04-07. A calendar-day reading of "+3" would land
  //                 on Sat 2015-04-04; a reading that forgot Good Friday would
  //                 land on the 6th. This line catches both.
  assert.deepEqual(
    gen.trades.map((t) => [t.boundaryMonth, t.anchorDate, t.entryDate, t.exitDate]),
    [
      ["2015-02", "2015-02-02", "2015-01-30", "2015-02-05"],
      ["2015-03", "2015-03-02", "2015-02-27", "2015-03-05"],
      ["2015-04", "2015-04-01", "2015-03-31", "2015-04-07"],
    ],
  );

  const feb = gen.trades[0]!;
  const entry = bars.find((b) => b.date === "2015-01-30")!;
  const exit = bars.find((b) => b.date === "2015-02-05")!;
  assert.equal(feb.entryClose, entry.close);
  assert.equal(feb.exitClose, exit.close);
  assert.equal(feb.grossReturn, TURN_OF_MONTH_SPEC.size * (exit.close / entry.close - 1));
});

test("the month-boundary anchor is the FIRST SESSION of a month, and index 0 can never be one", () => {
  const bars = fixtureBars("2015-01-02", "2015-04-30");
  const anchors = monthBoundaryIndices(bars).map((i) => bars[i]!.date);
  assert.deepEqual(anchors, ["2015-02-02", "2015-03-02", "2015-04-01"]);
  assert.ok(!monthBoundaryIndices(bars).includes(0), "a boundary with no prior bar cannot supply a T−1");
});

test("size scales the trade, and an exit that is not after the entry is rejected", () => {
  const bars = fixtureBars("2015-01-02", "2015-04-30");
  const one = generateTurnOfMonthTrades(bars, {
    entryOffsetDays: -1, exitOffsetDays: 3, size: 1, window: { start: "2015-01-02", end: "2015-04-30" },
  });
  const two = generateTurnOfMonthTrades(bars, {
    entryOffsetDays: -1, exitOffsetDays: 3, size: 2, window: { start: "2015-01-02", end: "2015-04-30" },
  });
  assert.equal(two.trades[0]!.grossReturn, one.trades[0]!.grossReturn * 2);

  assert.throws(
    () => generateTurnOfMonthTrades(bars, { entryOffsetDays: 3, exitOffsetDays: -1, size: 1, window: { start: "2015-01-02", end: "2015-04-30" } }),
    /must be strictly after/,
  );
});

test("bars that did not pass the integrity guard make the generator THROW, not guess", () => {
  const bars = fixtureBars("2015-01-02", "2015-04-30");
  const unsorted = [bars[5]!, bars[4]!, ...bars.slice(6)];
  assert.throws(() => generateTurnOfMonthTrades(unsorted, { entryOffsetDays: -1, exitOffsetDays: 3, size: 1, window: { start: "2015-01-02", end: "2015-04-30" } }), /ascending/);

  const zeroed = bars.map((b, i) => (i === 10 ? { date: b.date, close: 0 } : b));
  assert.throws(() => generateTurnOfMonthTrades(zeroed, { entryOffsetDays: -1, exitOffsetDays: 3, size: 1, window: { start: "2015-01-02", end: "2015-04-30" } }), /non-positive/);
});

// ── 2. the window seam ───────────────────────────────────────────────────────

test("a boundary whose entry bar sits outside the window is SKIPPED LOUDLY, never leaked", () => {
  // The January-2016 boundary enters on 2015-12-31 — the last session of the
  // FIT window — and exits inside the holdout. Including it would make the
  // evaluation read a fitted bar.
  const bars = fixtureBars("2015-11-02", "2016-03-31");
  const gen = generateTurnOfMonthTrades(bars, {
    entryOffsetDays: -1,
    exitOffsetDays: 3,
    size: 1,
    window: TURN_OF_MONTH_SPEC.holdoutWindow,
  });
  const jan = gen.skipped.find((s) => s.boundaryMonth === "2016-01");
  assert.ok(jan, "the seam boundary must appear in `skipped`, not vanish");
  assert.equal(jan.reason, "ENTRY_BAR_OUTSIDE_WINDOW");
  assert.match(jan.detail, /2015-12-31/);
  assert.ok(
    gen.trades.every((t) => t.entryDate >= TURN_OF_MONTH_SPEC.holdoutWindow.start),
    "no trade may read a bar from before the window",
  );
  assert.equal(gen.trades[0]!.boundaryMonth, "2016-02");
});

test("the reported data window is DERIVED from the bars actually read, not asserted", () => {
  const bars = fixtureBars("2016-01-04", "2016-06-30");
  const gen = generateTurnOfMonthTrades(bars, {
    entryOffsetDays: -1, exitOffsetDays: 3, size: 1, window: { start: "2016-01-04", end: "2016-06-30" },
  });
  assert.ok(gen.barsRead);
  assert.equal(gen.barsRead.start, gen.trades[0]!.entryDate);
  assert.equal(gen.barsRead.end, gen.trades[gen.trades.length - 1]!.exitDate);
  assert.ok(gen.barsRead.start > "2016-01-04", "the window start is not the series start — no trade reads bar 0");
});

test("a window with no complete trade is a typed refusal, never an empty track passed off as a zero edge", () => {
  const bars = fixtureBars("2016-01-04", "2016-06-30");
  const r = buildTurnOfMonthEvaluationInput(bars, TURN_OF_MONTH_SPEC, { start: "2016-03-07", end: "2016-03-11" }, {
    at: AT, costModel: COST_MODEL, fingerprintSymbol: "TEST", fingerprintAdjustment: "split_dividend_adjusted", nTrials: 1,
  });
  assert.ok(isTurnOfMonthBuildRefusal(r));
  assert.equal(r.code, "NO_TRADES");
  assert.match(r.detail, /failed read, not a zero edge/);
});

// ── 3. the harness still refuses ─────────────────────────────────────────────

function holdoutBuild() {
  const bars = fixtureBars("2016-01-04", "2018-12-31");
  const build = buildTurnOfMonthEvaluationInput(bars, TURN_OF_MONTH_SPEC, { start: "2016-01-04", end: "2018-12-31" }, {
    at: AT, costModel: COST_MODEL, fingerprintSymbol: "TEST", fingerprintAdjustment: "split_dividend_adjusted", nTrials: 1,
  });
  assert.ok(!isTurnOfMonthBuildRefusal(build));
  return { bars, build };
}

test("harness: this wiring cannot evaluate without a locked pre-registration", () => {
  const { build } = holdoutBuild();
  const h = new TransferProofHarness();
  const r = h.evaluate(TURN_OF_MONTH_SPEC, build.input);
  assert.ok(isRefusal(r));
  assert.equal(r.code, "NOT_REGISTERED");
});

test("harness: a spec that mutated after locking is refused BY HASH", () => {
  const { build } = holdoutBuild();
  const h = new TransferProofHarness();
  assert.ok(!isRefusal(h.register(TURN_OF_MONTH_SPEC, AT)));
  const mutated: ExperimentSpec = { ...TURN_OF_MONTH_SPEC, exitOffsetDays: 4 };
  const r = h.evaluate(mutated, build.input);
  assert.ok(isRefusal(r));
  assert.equal(r.code, "SPEC_HASH_MUTATED");
});

test("harness: fit-window data is refused, and a zero-cost evaluation is refused", () => {
  const fitBars = fixtureBars("2014-01-02", "2015-12-31");
  const fitBuild = buildTurnOfMonthEvaluationInput(fitBars, TURN_OF_MONTH_SPEC, { start: "2014-01-02", end: "2015-12-31" }, {
    at: AT, costModel: COST_MODEL, fingerprintSymbol: "TEST", fingerprintAdjustment: "split_dividend_adjusted", nTrials: 1,
  });
  assert.ok(!isTurnOfMonthBuildRefusal(fitBuild));
  const h = new TransferProofHarness();
  assert.ok(!isRefusal(h.register(TURN_OF_MONTH_SPEC, AT)));

  const overlap = h.evaluate(TURN_OF_MONTH_SPEC, fitBuild.input);
  assert.ok(isRefusal(overlap));
  assert.equal(overlap.code, "FIT_WINDOW_OVERLAP");

  const { build } = holdoutBuild();
  const gross = h.evaluate(TURN_OF_MONTH_SPEC, {
    ...build.input,
    costs: { ...build.input.costs, perSideCostFrac: 0 },
  });
  assert.ok(isRefusal(gross));
  assert.equal(gross.code, "GROSS_ONLY");
});

test("harness: an evaluation this wiring builds is ACCEPTED once the spec is locked (the pipe works)", () => {
  const { build } = holdoutBuild();
  const h = new TransferProofHarness();
  const reg = h.register(TURN_OF_MONTH_SPEC, AT);
  assert.ok(!isRefusal(reg));
  const ev = h.evaluate(TURN_OF_MONTH_SPEC, build.input);
  assert.ok(!isRefusal(ev));
  assert.equal(ev.evaluation!.nObs, build.trades.length);
  assert.equal(ev.evaluation!.dataFingerprint, build.input.dataFingerprint);
  assert.equal(ev.evaluation!.costModelHash, COST_MODEL.modelHash);
});

test("harness: the SHADOW_CI clause makes a verdict with no shadow data a guaranteed MISS", () => {
  // The trap the owner-press script exists to prevent: the pass bar is an AND,
  // so seeking a verdict before shadow observations exist retires the
  // experiment on a technicality.
  const { build } = holdoutBuild();
  const h = new TransferProofHarness();
  const reg = h.register(TURN_OF_MONTH_SPEC, AT);
  assert.ok(!isRefusal(reg));
  assert.ok(!isRefusal(h.evaluate(TURN_OF_MONTH_SPEC, build.input)));
  const v = h.verdict(reg.specHash, AT);
  assert.ok(!isRefusal(v));
  assert.equal(v.verdict, "MISS");
  const shadow = v.clauses.find((c) => c.clause === "SHADOW_CI")!;
  assert.equal(shadow.pass, false);
  assert.match(shadow.detail, /only 0\/6 shadow observations/);
  assert.ok(v.fdrCharge, "a MISS charges the family's FDR — which is why it must not happen by accident");
  assert.equal(h.get(reg.specHash)!.status, "RETIRED");
});

// ── 4. the pre-registration lock ─────────────────────────────────────────────

test("the locked spec hash is pinned as a literal and matches the spec as written", () => {
  const check = verifyTurnOfMonthPreRegistration();
  assert.equal(check.intact, true, check.intact ? "" : check.detail);
  assert.equal(specHashOf(TURN_OF_MONTH_SPEC), TURN_OF_MONTH_LOCKED_SPEC_HASH);
});

test("ANY edit to the spec breaks the lock — this is the check that survives a restart", () => {
  const edits: Array<[string, ExperimentSpec]> = [
    ["the exit offset", { ...TURN_OF_MONTH_SPEC, exitOffsetDays: 4 }],
    ["the entry offset", { ...TURN_OF_MONTH_SPEC, entryOffsetDays: -2 }],
    ["the instrument", { ...TURN_OF_MONTH_SPEC, instrument: "SPY" }],
    ["the size", { ...TURN_OF_MONTH_SPEC, size: 2 }],
    ["the holdout window", { ...TURN_OF_MONTH_SPEC, holdoutWindow: { start: "2016-01-01", end: "2024-12-31" } }],
    ["the pass bar", { ...TURN_OF_MONTH_SPEC, passBar: { ...TURN_OF_MONTH_SPEC.passBar, minNetSharpe: 0.1 } }],
    ["the notes", { ...TURN_OF_MONTH_SPEC, notes: "reworded" }],
  ];
  for (const [what, spec] of edits) {
    const c = verifyTurnOfMonthPreRegistration(spec);
    assert.equal(c.intact, false, `editing ${what} must break the lock`);
    assert.match(c.intact === false ? c.detail : "", /new, unregistered experiment/);
  }
});

// ── 5. costs and the fingerprint ─────────────────────────────────────────────

test("netting only ever subtracts, and charges one full round trip per trade", () => {
  const { build } = holdoutBuild();
  const net = build.input.netOosReturns;
  assert.equal(net.length, build.grossReturns.length);
  for (let i = 0; i < net.length; i++) {
    assert.ok(net[i]! <= build.grossReturns[i]!, `net[${i}] must not exceed gross[${i}]`);
  }
  const perTrade = COST_MODEL.perSideCostFrac * 2 * TURN_OF_MONTH_SPEC.size;
  assert.ok(Math.abs(build.totalCostCharged - perTrade * net.length) < 1e-12);
  assert.equal(build.input.costs.scheduleKind, "roundTripPerObservation");
  assert.equal(build.input.costs.applied, true);
});

test("the fingerprint covers exactly the bars READ — not the whole series", () => {
  const { bars, build } = holdoutBuild();
  assert.ok(build.fingerprintedBars.length < bars.length, "the OOS slice is a strict subset of the series");
  assert.equal(build.fingerprintedBars[0]!.date, build.input.dataWindow.start);
  assert.equal(build.fingerprintedBars[build.fingerprintedBars.length - 1]!.date, build.input.dataWindow.end);
  assert.equal(
    build.input.dataFingerprint,
    dataFingerprint({ symbol: "TEST", adjustment: "split_dividend_adjusted", bars: build.fingerprintedBars }),
  );
  // A bar OUTSIDE the read slice changes the series but must not change the
  // identity of the data the evaluation consumed.
  const padded = [{ date: "2015-12-31", close: 1 }, ...bars];
  const rebuilt = buildTurnOfMonthEvaluationInput(padded, TURN_OF_MONTH_SPEC, { start: "2016-01-04", end: "2018-12-31" }, {
    at: AT, costModel: COST_MODEL, fingerprintSymbol: "TEST", fingerprintAdjustment: "split_dividend_adjusted", nTrials: 1,
  });
  assert.ok(!isTurnOfMonthBuildRefusal(rebuilt));
  assert.equal(rebuilt.input.dataFingerprint, build.input.dataFingerprint);
});

// ── 6. the selection field ───────────────────────────────────────────────────

test("the selection field is rectangular and contains the pre-registered variant", () => {
  const bars = fixtureBars("2005-01-03", "2015-12-31");
  const sel = buildFitSelectionField(bars, TURN_OF_MONTH_SPEC, TURN_OF_MONTH_SPEC.fitWindow, COST_MODEL);
  assert.equal(sel.field.length, DECLARED_FIT_VARIANT_GRID.length);
  const width = sel.field[0]!.length;
  assert.ok(width > 20, `PBO needs a real track; got ${width} common boundaries`);
  for (const row of sel.field) assert.equal(row.length, width, "estimatePbo requires equal-length rows");
  assert.ok(sel.specVariantIndex >= 0, "the field must contain the variant that was actually selected");
  const v = sel.variants[sel.specVariantIndex]!;
  assert.equal(v.entryOffsetDays, TURN_OF_MONTH_SPEC.entryOffsetDays);
  assert.equal(v.exitOffsetDays, TURN_OF_MONTH_SPEC.exitOffsetDays);
  assert.equal(sel.commonBoundaryMonths.length, width);
  assert.deepEqual([...sel.commonBoundaryMonths].sort(), sel.commonBoundaryMonths, "boundaries are aligned in time order");
});

test("without a selection field the PBO clause FAILS — unmeasurable is not low", () => {
  const { build } = holdoutBuild();
  assert.equal(build.input.selectionField, undefined);
  const h = new TransferProofHarness();
  const reg = h.register(TURN_OF_MONTH_SPEC, AT);
  assert.ok(!isRefusal(reg));
  assert.ok(!isRefusal(h.evaluate(TURN_OF_MONTH_SPEC, build.input)));
  const v = h.verdict(reg.specHash, AT);
  assert.ok(!isRefusal(v));
  const pbo = v.clauses.find((c) => c.clause === "PBO")!;
  assert.equal(pbo.pass, false);
  assert.equal(pbo.observed, null);
  assert.match(pbo.detail, /UNMEASURABLE/);
});

// ── 7. the PBO clause is decided BEFORE the holdout is read ──────────────────
//
// This is the trap the owner-press script's step 2b exists to catch, and it is
// the same shape as the SHADOW_CI trap: a clause of an AND-ed pass bar whose
// value is knowable in advance, so a runbook followed end-to-end can spend the
// one shot on an arithmetic certainty and charge FDR for it.

test("PBO is computed from the FIT selection field ALONE — the holdout never enters it", () => {
  const fitBars = fixtureBars("2005-01-03", "2015-12-31");
  const sel = buildFitSelectionField(fitBars, TURN_OF_MONTH_SPEC, TURN_OF_MONTH_SPEC.fitWindow, COST_MODEL);
  const preflight = estimatePbo(sel.field, 10);
  assert.ok(Number.isFinite(preflight.pbo), "the fixture must produce a measurable PBO");

  // Two DIFFERENT out-of-sample tracks, same selection field. If PBO depended on
  // the holdout at all, these two evaluations would disagree.
  const { build } = holdoutBuild();
  const withField = (mutate: (r: number[]) => number[]) => {
    const h = new TransferProofHarness();
    const reg = h.register(TURN_OF_MONTH_SPEC, AT);
    assert.ok(!isRefusal(reg));
    const ev = h.evaluate(TURN_OF_MONTH_SPEC, {
      ...build.input,
      netOosReturns: mutate([...build.input.netOosReturns]),
      selectionField: sel.field,
      pboBlocks: 10,
    });
    assert.ok(!isRefusal(ev));
    return ev.evaluation!;
  };

  const asIs = withField((r) => r);
  const flipped = withField((r) => r.map((x) => -x));
  assert.notEqual(asIs.netSharpe, flipped.netSharpe, "the two holdout tracks must genuinely differ");
  assert.equal(asIs.pbo, preflight.pbo, "the harness's PBO IS the fit-only pre-flight number");
  assert.equal(flipped.pbo, preflight.pbo, "inverting every OOS return moves PBO not at all");
});

test("pboPreflight decides the clause the same way the pass bar does, UNMEASURABLE included", () => {
  const fitBars = fixtureBars("2005-01-03", "2015-12-31");
  const sel = buildFitSelectionField(fitBars, TURN_OF_MONTH_SPEC, TURN_OF_MONTH_SPEC.fitWindow, COST_MODEL);
  const pre = pboPreflight(sel.field);
  assert.equal(pre.blocks, PBO_PREFLIGHT_BLOCKS, "the pre-flight and the clause must share a block count");
  assert.equal(pre.pbo, estimatePbo(sel.field, PBO_PREFLIGHT_BLOCKS).pbo);
  assert.equal(pre.wouldPass, pre.pbo < TURN_OF_MONTH_SPEC.passBar.maxPbo);

  // A single-strategy field is UNMEASURABLE, and unmeasurable must FAIL: the
  // clause is `pbo < bar`, and !(NaN < bar) is true.
  const single = pboPreflight([[0.01, -0.02, 0.03]]);
  assert.ok(Number.isNaN(single.pbo));
  assert.equal(single.wouldPass, false, "an unmeasurable overfitting probability is not a low one");

  // And the bar comes from the SPEC, not from a literal: a spec with a bar of 1
  // passes the same field the pre-registered bar of 0.2 rejects.
  const permissive: ExperimentSpec = {
    ...TURN_OF_MONTH_SPEC,
    passBar: { ...TURN_OF_MONTH_SPEC.passBar, maxPbo: 1 },
  };
  assert.equal(pboPreflight(sel.field, permissive).wouldPass, true);
});

test("a fit field whose PBO fails the bar makes the verdict a MISS whatever the holdout says", () => {
  // A selection field of pure noise ranks the in-sample winner at random out of
  // sample, so PBO lands near 0.5 — far above the 0.2 bar. This is the state in
  // which pressing on retires the experiment for nothing.
  const noise: number[][] = [];
  for (let s = 0; s < 12; s++) {
    const row: number[] = [];
    // Deterministic, decorrelated per strategy. No RNG: the assertion has to be
    // reproducible or it is not evidence.
    for (let t = 0; t < 120; t++) row.push(Math.sin((s + 1) * 7.13 + t * 1.7) * 0.01);
    noise.push(row);
  }
  const pre = estimatePbo(noise, 10);
  assert.ok(Number.isFinite(pre.pbo));
  assert.ok(
    pre.pbo >= TURN_OF_MONTH_SPEC.passBar.maxPbo,
    `the fixture must be a failing field; got PBO ${pre.pbo} against a bar of < ${TURN_OF_MONTH_SPEC.passBar.maxPbo}`,
  );

  const { build } = holdoutBuild();
  const h = new TransferProofHarness();
  const reg = h.register(TURN_OF_MONTH_SPEC, AT);
  assert.ok(!isRefusal(reg));
  assert.ok(!isRefusal(h.evaluate(TURN_OF_MONTH_SPEC, { ...build.input, selectionField: noise, pboBlocks: 10 })));
  // Satisfy the OTHER blocking clause so the MISS cannot be blamed on shadow data.
  for (let i = 0; i < TURN_OF_MONTH_SPEC.passBar.minShadowObservations + 2; i++) {
    assert.ok(!isRefusal(h.recordShadowPnl(reg.specHash, 5, AT)));
  }
  const v = h.verdict(reg.specHash, AT);
  assert.ok(!isRefusal(v));
  assert.equal(v.verdict, "MISS");
  const pbo = v.clauses.find((c) => c.clause === "PBO")!;
  assert.equal(pbo.pass, false, "the clause that was decided before the holdout is the one that fails");
  assert.equal(pbo.observed, pre.pbo, "and it is exactly the number a pre-flight could have printed for free");
  assert.ok(v.fdrCharge, "a foregone MISS charges FDR just like a real one — which is the harm");
});

// ── 8. the one-shot ledger — the durable half of "no second spin" ────────────
//
// The harness's own retirement memory is three private in-memory fields, so a
// fresh process starts with an empty `retiredOnData` and a MISS retires nothing
// across runs. These cover the file that does span runs.

const LEDGER_ROW: VerdictLedgerEntry = {
  format: VERDICT_LEDGER_FORMAT,
  kind: "VERDICT",
  experimentKey: TURN_OF_MONTH_SPEC.experimentKey,
  specHash: TURN_OF_MONTH_LOCKED_SPEC_HASH,
  dataFingerprint: "a".repeat(64),
  at: AT,
  verdict: "MISS",
  detail: "fixture",
};

test("the in-memory harness genuinely does NOT remember a retirement across processes", () => {
  // Not a wish: the exact behaviour the durable ledger exists to cover. A second
  // harness — which is what every CLI invocation builds — knows nothing.
  const { build } = holdoutBuild();
  const first = new TransferProofHarness();
  const reg = first.register(TURN_OF_MONTH_SPEC, AT);
  assert.ok(!isRefusal(reg));
  assert.ok(!isRefusal(first.evaluate(TURN_OF_MONTH_SPEC, build.input)));
  const v1 = first.verdict(reg.specHash, AT);
  assert.ok(!isRefusal(v1));
  assert.equal(v1.verdict, "MISS");
  assert.equal(first.get(reg.specHash)!.status, "RETIRED");

  const second = new TransferProofHarness();
  assert.ok(second.get(reg.specHash) == null, "a new harness has no memory of the retirement");
  const reg2 = second.register(TURN_OF_MONTH_SPEC, AT);
  assert.ok(!isRefusal(reg2), "and it re-registers the retired spec cleanly — this is the hole the file closes");
});

test("ledger: the same spec on the same data is refused, and a different dataset is a different shot", () => {
  const entries = [LEDGER_ROW];
  assert.ok(findSpentShot(entries, LEDGER_ROW.specHash, LEDGER_ROW.dataFingerprint), "same spec + same data is spent");
  assert.equal(findSpentShot(entries, LEDGER_ROW.specHash, "b".repeat(64)), null, "new data is a new shot");
  assert.equal(findSpentShot(entries, "c".repeat(64), LEDGER_ROW.dataFingerprint), null, "a new spec is a new shot");
  assert.equal(findSpentShot([], LEDGER_ROW.specHash, LEDGER_ROW.dataFingerprint), null, "an empty ledger blocks nothing");
});

test("ledger: an INTENT row with no outcome still spends the shot — a crash mid-press is not a refund", () => {
  const intentOnly: VerdictLedgerEntry = { ...LEDGER_ROW, kind: "VERDICT_INTENT", verdict: undefined, detail: undefined };
  const hit = findSpentShot([intentOnly], LEDGER_ROW.specHash, LEDGER_ROW.dataFingerprint);
  assert.ok(hit, "the shot is spent the moment the press begins");
  assert.match(describeLedgerEntry(hit), /the press BEGAN and no outcome row followed/);
});

test("ledger: round-trips as one JSON line, and a malformed line REFUSES THE WHOLE FILE", () => {
  const text = serialiseLedgerEntry(LEDGER_ROW) + serialiseLedgerEntry({ ...LEDGER_ROW, kind: "VERDICT_INTENT" });
  assert.equal(text.split("\n").filter((l) => l.length > 0).length, 2, "one entry, one line");
  const parsed = parseVerdictLedger(text);
  assert.ok(parsed.ok);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0], LEDGER_ROW);

  // The dangerous failure is a corrupt ledger read as "nothing here" — that is
  // how a spent shot gets handed back — so it must be a refusal, not a skip.
  for (const corrupt of ["{not json}", '{"format":"something-else"}', `{"format":"${VERDICT_LEDGER_FORMAT}","kind":"VERDICT"}`]) {
    const bad = parseVerdictLedger(text + corrupt + "\n");
    assert.equal(bad.ok, false, `${corrupt} must refuse the file`);
  }
  const blanks = parseVerdictLedger("\n\n" + text + "\n\n");
  assert.ok(blanks.ok, "blank lines are not corruption");
  assert.equal(blanks.entries.length, 2);
});
