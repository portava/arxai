// ═══════════════════════════════════════════════════════════════════════════
// HOLD 2 — CAPACITY EVIDENCE DERIVATION. The arithmetic, actually executed.
//
// WHY THIS SUITE EXISTS: the proposal suite next door proves the PURE BUILDER
// behaves, but it feeds that builder hand-written evidence fixtures. The layer
// that turns real broker rows INTO those fixtures — the R-multiple math, the
// drop classification, the slippage formula, the venue-failure heuristic — was
// covered only by `readFileSync` + `includes()` source greps. A grep proves the
// file does not contain `db.update(`. It proves nothing about whether the
// numbers are right.
//
// That distinction is the whole risk. A mis-derived R does not throw and does
// not fail a grep: it produces a PLAUSIBLE WRONG NUMBER, labelled LOW or
// MODERATE confidence, on the exact surface the owner is told to read before
// pressing. "It returns a clean 503 if the table is missing" is not the failure
// mode that matters here.
//
// Executing it immediately found one. See the FIRST test below.
//
// IO-free and deterministic — the module under test imports no `db`, no clock
// and no RNG. Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:edge-capacity-derivation

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRealizedEvidence,
  deriveLiquidityEvidence,
  referencePriceOf,
  finite,
  specKey,
  DROP_NO_PNL,
  DROP_NO_STOP,
  DROP_NO_ENTRY,
  DROP_NO_VOLUME,
  DROP_NO_SPEC,
  DROP_NO_CONTRACT_SIZE,
  DROP_ZERO_RISK,
  RECONCILED_BROKER_ABSENT,
  type ClosedPositionRow,
  type EntryCommandRow,
  type SymbolSpec,
} from "../edgeCapacityDerivation.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const USD: SymbolSpec = { contractSize: 10, profitCurrency: "USD" };

/** A clean closed position: entry 100, stop 90, 1 lot, contract size 10.
 *  Planned risk = |100 − 90| × 10 × 1 = $100.
 *
 *  The prices are round on purpose. Real symbols are not, but a fixture built
 *  from 1.1000 − 1.0900 asserts against 1.4999999999999984 and teaches nothing
 *  about the formula — the binary-representation noise would be the only thing
 *  under test. */
function closedRow(over: Partial<ClosedPositionRow> = {}): ClosedPositionRow {
  return {
    userId: 1,
    symbol: "EURUSD",
    volume: 1,
    entryPrice: 100,
    stopLoss: 90,
    realisedPnl: 150,
    closeReportedAt: new Date("2026-08-01T00:00:00.000Z"),
    reconcileState: null,
    ...over,
  };
}

function specs(entries: Array<[number, string, SymbolSpec]> = [[1, "EURUSD", USD]]) {
  return new Map(entries.map(([u, s, spec]) => [specKey(u, s), spec]));
}

function cmdRow(over: Partial<EntryCommandRow> = {}): EntryCommandRow {
  return {
    filledAt: new Date("2026-08-01T00:00:00.000Z"),
    rejectedAt: null,
    expiredAt: null,
    requestedVolume: 1,
    executedVolume: 1,
    fillPrice: 100,
    stopLoss: 90,
    payload: { referencePrice: 99.5 },
    ...over,
  };
}

function dropCount(
  d: ReturnType<typeof deriveRealizedEvidence>,
  reason: string,
): number {
  return d.dropped.find((x) => x.reason === reason)?.count ?? 0;
}

// ═══ 0. THE DEFECT THIS SUITE EXISTED TO CATCH ═════════════════════════════

test("REGRESSION: a closed position with NO broker-reported P&L is DROPPED, never scored as a break-even trade", () => {
  // The bug: the collector's local `finite()` was
  //     const n = typeof x === "number" ? x : Number(x);
  //     return Number.isFinite(n) ? n : null;
  // and `Number(null)` is 0, which `Number.isFinite` accepts. So a position the
  // broker never reported a P&L for came back as 0 — a CONFIDENT ZERO — and
  // was scored as a real break-even trade at 0R.
  //
  // Every other leg happened to be shielded by a `> 0` guard (a null stop, a
  // null entry, a null volume all coerced to 0 and were rejected as
  // non-positive). P&L legitimately CAN be zero, so it had no such guard, and
  // it was the one leg where a missing broker report became a data point.
  //
  // Two harms, both silent, both in the dangerous direction: the sample count
  // was inflated toward the 30-trade sufficiency floor by trades that never
  // resolved, and the distribution was dragged toward 0R — which reads as a
  // tighter, safer edge than the evidence supports.
  const d = deriveRealizedEvidence(
    [closedRow({ realisedPnl: null }), closedRow({ realisedPnl: undefined })],
    specs(),
  );
  assert.deepEqual(d.rMultiples, [],
    "an unreported P&L is an ABSENCE. It is not a trade that broke even.");
  assert.equal(dropCount(d, DROP_NO_PNL), 2, "both must be dropped by name");

  // …and the same coercion silently suppressed the venue-failure count, since
  // the heuristic asks whether a REPORTED close carries no usable P&L.
  assert.equal(d.venueFailures, 2,
    "a close the broker reported without numbers IS the venue-failure observable");
});

test("`finite` treats absence as absence and zero as zero", () => {
  assert.equal(finite(null), null);
  assert.equal(finite(undefined), null);
  assert.equal(finite(""), null, "an empty string is not a measurement of zero");
  assert.equal(finite("abc"), null);
  assert.equal(finite(NaN), null);
  assert.equal(finite(Infinity), null);
  // A real zero survives: P&L of exactly 0 is a genuine break-even outcome.
  assert.equal(finite(0), 0);
  assert.equal(finite("0"), 0, "numeric columns arrive as strings from the driver");
  assert.equal(finite("-12.5"), -12.5);
  assert.equal(finite(-3), -3);
});

// ═══ 1. THE R-MULTIPLE MATH ════════════════════════════════════════════════

test("R is realised P&L over PLANNED risk, and the arithmetic is the arithmetic", () => {
  // planned risk = |100 − 90| × 10 × 1 = $100
  const d = deriveRealizedEvidence([closedRow({ realisedPnl: 150 })], specs());
  assert.deepEqual(d.rMultiples, [1.5]);
  assert.deepEqual(d.dropped, []);

  const loss = deriveRealizedEvidence([closedRow({ realisedPnl: -100 })], specs());
  assert.deepEqual(loss.rMultiples, [-1], "a full stop-out is exactly −1R");

  const breakEven = deriveRealizedEvidence([closedRow({ realisedPnl: 0 })], specs());
  assert.deepEqual(breakEven.rMultiples, [0],
    "a REPORTED zero P&L is a real 0R trade and must survive — the absence case is the one that drops");
});

test("R does not care which side of the stop the entry is on", () => {
  // A short: entry 90, stop 100. The same $100 of planned risk.
  const short = deriveRealizedEvidence(
    [closedRow({ entryPrice: 90, stopLoss: 100, realisedPnl: 200 })], specs());
  assert.deepEqual(short.rMultiples, [2],
    "planned risk is a DISTANCE; a short must not come out negative");
});

test("planned risk scales with volume and contract size, so R does not", () => {
  const tenX = deriveRealizedEvidence(
    [closedRow({ volume: 10, realisedPnl: 1500 })], specs());
  assert.deepEqual(tenX.rMultiples, [1.5], "10× the size at 10× the P&L is the same R");

  const smallContract = deriveRealizedEvidence(
    [closedRow({ realisedPnl: 15 })],
    specs([[1, "EURUSD", { contractSize: 1, profitCurrency: "USD" }]]));
  assert.deepEqual(smallContract.rMultiples, [1.5]);
});

test("numeric columns arriving as strings are still real numbers", () => {
  const d = deriveRealizedEvidence([closedRow({
    volume: "1", entryPrice: "100", stopLoss: "90", realisedPnl: "150",
  })], specs([[1, "EURUSD", { contractSize: "10", profitCurrency: "USD" }]]));
  assert.deepEqual(d.rMultiples, [1.5]);
});

// ═══ 2. THE DROP CLASSIFICATION ════════════════════════════════════════════

test("every unresolvable leg is dropped, counted and named — never back-filled", () => {
  const rows = [
    closedRow({ realisedPnl: null }),                                  // no P&L
    closedRow({ stopLoss: null }),                                     // no planned risk
    closedRow({ entryPrice: null }),                                   // no entry
    closedRow({ volume: null }),                                       // no volume
    closedRow({ symbol: "GBPJPY" }),                                   // no spec
    closedRow({ entryPrice: 100, stopLoss: 100 }),                     // zero risk
  ];
  const d = deriveRealizedEvidence(rows, specs());
  assert.deepEqual(d.rMultiples, [], "not one of these may produce a number");
  assert.equal(dropCount(d, DROP_NO_PNL), 1);
  assert.equal(dropCount(d, DROP_NO_STOP), 1);
  assert.equal(dropCount(d, DROP_NO_ENTRY), 1);
  assert.equal(dropCount(d, DROP_NO_VOLUME), 1);
  assert.equal(dropCount(d, DROP_NO_SPEC), 1);
  assert.equal(dropCount(d, DROP_ZERO_RISK), 1);
  assert.equal(d.dropped.reduce((s, x) => s + x.count, 0), rows.length,
    "every attributed row is either an R multiple or a named drop — nothing evaporates");
});

test("a stop-loss of 0 is 'no stop recorded', not a stop at price zero", () => {
  const d = deriveRealizedEvidence([closedRow({ stopLoss: 0 })], specs());
  assert.deepEqual(d.rMultiples, []);
  assert.equal(dropCount(d, DROP_NO_STOP), 1,
    "treating 0 as a real stop price would invent an enormous planned risk and a near-zero R");
});

test("a missing contract size drops the row instead of assuming a lot size", () => {
  const d = deriveRealizedEvidence([closedRow()],
    specs([[1, "EURUSD", { contractSize: null, profitCurrency: "USD" }]]));
  assert.deepEqual(d.rMultiples, []);
  assert.equal(dropCount(d, DROP_NO_CONTRACT_SIZE), 1);
});

test("a non-USD profit currency is dropped by name, never converted at today's rate", () => {
  const d = deriveRealizedEvidence([closedRow(), closedRow()],
    specs([[1, "EURUSD", { contractSize: 10, profitCurrency: "GBP" }]]));
  assert.deepEqual(d.rMultiples, []);
  const reason = d.dropped[0]!.reason;
  assert.match(reason, /GBP/, "the operator must be able to see WHICH currency");
  assert.match(reason, /FX rate/);
  assert.equal(d.dropped[0]!.count, 2);

  const unknown = deriveRealizedEvidence([closedRow()],
    specs([[1, "EURUSD", { contractSize: 10, profitCurrency: null }]]));
  assert.match(unknown.dropped[0]!.reason, /UNKNOWN/,
    "an unrecorded currency is not silently assumed to be USD");
});

test("specs are per (user, symbol): user A's contract spec never stands in for user B's", () => {
  const d = deriveRealizedEvidence(
    [closedRow({ userId: 1 }), closedRow({ userId: 2 })],
    specs([[1, "EURUSD", USD]]),
  );
  assert.deepEqual(d.rMultiples, [1.5], "only user 1's position resolves");
  assert.equal(dropCount(d, DROP_NO_SPEC), 1, "user 2's must drop, not borrow");
});

test("drops are ordered most-common-first so the operator reads the real blocker first", () => {
  const d = deriveRealizedEvidence([
    closedRow({ stopLoss: null }), closedRow({ stopLoss: null }),
    closedRow({ stopLoss: null }), closedRow({ realisedPnl: null }),
  ], specs());
  assert.equal(d.dropped[0]!.reason, DROP_NO_STOP);
  assert.equal(d.dropped[0]!.count, 3);
});

test("an empty attribution set is honestly empty, with no drops invented", () => {
  const d = deriveRealizedEvidence([], specs());
  assert.deepEqual(d.rMultiples, []);
  assert.deepEqual(d.dropped, []);
  assert.equal(d.venueFailures, 0);
});

// ═══ 3. THE VENUE-FAILURE HEURISTIC ════════════════════════════════════════

test("venue failures are counted over ALL attributed closes, including resolvable ones", () => {
  const d = deriveRealizedEvidence([
    closedRow(),                                                    // clean
    closedRow({ reconcileState: RECONCILED_BROKER_ABSENT }),        // absent AND resolvable
    closedRow({ realisedPnl: null }),                               // reported, no numbers
  ], specs());
  assert.equal(d.venueFailures, 2);
  assert.deepEqual(d.rMultiples, [1.5, 1.5],
    "a broker-absent close that still has usable numbers is BOTH a venue failure and a data point — the two counts are independent observables");
});

test("a position the broker never reported closed is not a venue failure", () => {
  const d = deriveRealizedEvidence(
    [closedRow({ closeReportedAt: null, realisedPnl: null })], specs());
  assert.equal(d.venueFailures, 0,
    "no close report means we have not heard from the venue — that is silence, not a proven failure");
  assert.equal(dropCount(d, DROP_NO_PNL), 1, "it is still unusable, and still dropped");
});

test("an unrelated reconcile state is not read as a venue failure", () => {
  for (const s of ["IGNORED", "EXTERNAL", "IMPORTED", null]) {
    const d = deriveRealizedEvidence([closedRow({ reconcileState: s })], specs());
    assert.equal(d.venueFailures, 0, `${s} must not be counted as a venue failure`);
  }
});

// ═══ 4. THE LIQUIDITY DERIVATION ═══════════════════════════════════════════

test("dispatch outcomes are classified once each, and in-flight is its own bucket", () => {
  const d = deriveLiquidityEvidence([
    cmdRow(),
    cmdRow({ filledAt: null, rejectedAt: new Date() }),
    cmdRow({ filledAt: null, expiredAt: new Date() }),
    cmdRow({ filledAt: null }),                                     // still in flight
  ]);
  assert.deepEqual(d.dispatch, { filled: 1, rejected: 1, expired: 1, stillInFlight: 1 });
});

test("a filled command that was also stamped rejected counts ONCE, as filled", () => {
  const d = deriveLiquidityEvidence([cmdRow({ rejectedAt: new Date(), expiredAt: new Date() })]);
  assert.deepEqual(d.dispatch, { filled: 1, rejected: 0, expired: 0, stillInFlight: 0 },
    "double-counting would inflate the resolved-dispatch denominator and understate the fill rate");
});

test("slippage is |fill − reference| ÷ |fill − stop|, already in planned-risk R", () => {
  // |100 − 99.5| = 0.5 ; |100 − 90| = 10 → 0.05R
  const d = deriveLiquidityEvidence([cmdRow()]);
  assert.deepEqual(d.slippageRSamples, [0.05]);
});

test("slippage is a MAGNITUDE — a fill better than the reference is not negative slippage", () => {
  const better = deriveLiquidityEvidence([cmdRow({ payload: { referencePrice: 100.5 } })]);
  assert.deepEqual(better.slippageRSamples, [0.05],
    "a signed sample would let favourable fills cancel adverse ones and understate the friction");
});

test("slippage needs no contract spec: size cancels out of the ratio", () => {
  // Same prices, wildly different volumes — the R cost is identical, which is
  // exactly why this leg cannot be silently zeroed by a missing spec.
  const a = deriveLiquidityEvidence([cmdRow({ requestedVolume: 0.01, executedVolume: 0.01 })]);
  const b = deriveLiquidityEvidence([cmdRow({ requestedVolume: 50, executedVolume: 50 })]);
  assert.deepEqual(a.slippageRSamples, b.slippageRSamples);
});

test("a command missing any price yields NO slippage sample — never a zero one", () => {
  const cases: Array<[string, Partial<EntryCommandRow>]> = [
    ["no fill price", { fillPrice: null }],
    ["fill price of 0", { fillPrice: 0 }],
    ["no reference price in the payload", { payload: {} }],
    ["null payload", { payload: null }],
    ["payload is not an object", { payload: "reference=1.0995" }],
    ["reference price of 0", { payload: { referencePrice: 0 } }],
    ["negative reference price", { payload: { referencePrice: -100 } }],
    ["no stop-loss", { stopLoss: null }],
    ["stop equals fill, so risk distance is zero", { stopLoss: 100 }],
  ];
  for (const [label, over] of cases) {
    const d = deriveLiquidityEvidence([cmdRow(over)]);
    assert.deepEqual(d.slippageRSamples, [],
      `${label}: a fabricated 0R slippage would OVERSTATE capacity — the dangerous direction`);
    assert.equal(d.dispatch.filled, 1, `${label}: the fill itself is still counted`);
  }
});

test("an unfilled command contributes no slippage and no partial-fill sample", () => {
  const d = deriveLiquidityEvidence([
    cmdRow({ filledAt: null, rejectedAt: new Date() }),
    cmdRow({ filledAt: null }),
  ]);
  assert.deepEqual(d.slippageRSamples, []);
  assert.equal(d.partialFillSamples, 0);
  assert.equal(d.partialFillMean01, null);
});

test("the partial-fill ratio is executed ÷ requested, capped at 1", () => {
  const d = deriveLiquidityEvidence([
    cmdRow({ requestedVolume: 1, executedVolume: 0.5 }),
    cmdRow({ requestedVolume: 1, executedVolume: 1 }),
  ]);
  assert.equal(d.partialFillSamples, 2);
  assert.equal(d.partialFillMean01, 0.75);

  const over = deriveLiquidityEvidence([cmdRow({ requestedVolume: 1, executedVolume: 1.4 })]);
  assert.equal(over.partialFillMean01, 1,
    "an over-fill is a data oddity, not 140% of a fill — it must not push the mean above 1");
});

test("partial fill is NOT MEASURED rather than 1.0 when the volumes were never recorded", () => {
  for (const over of [
    { requestedVolume: null }, { executedVolume: null },
    { requestedVolume: 0 }, { executedVolume: 0 },
  ]) {
    const d = deriveLiquidityEvidence([cmdRow(over)]);
    assert.equal(d.partialFillMean01, null,
      "null here makes the proposal DISCLOSE the optimism; a 1.0 would hide it as a measurement");
    assert.equal(d.partialFillSamples, 0);
  }
});

test("an empty command set is honestly empty, not honestly perfect", () => {
  const d = deriveLiquidityEvidence([]);
  assert.deepEqual(d.dispatch, { filled: 0, rejected: 0, expired: 0, stillInFlight: 0 });
  assert.deepEqual(d.slippageRSamples, []);
  assert.equal(d.partialFillMean01, null);
  assert.equal(d.partialFillSamples, 0);
});

// ═══ 5. PAYLOAD READING ════════════════════════════════════════════════════

test("referencePriceOf never trusts the payload's shape", () => {
  assert.equal(referencePriceOf({ referencePrice: 1.2345 }), 1.2345);
  assert.equal(referencePriceOf({ referencePrice: "1.2345" }), 1.2345,
    "a JSON payload may carry the price as a string");
  assert.equal(referencePriceOf(null), null);
  assert.equal(referencePriceOf(undefined), null);
  assert.equal(referencePriceOf("nope"), null);
  assert.equal(referencePriceOf(42), null);
  assert.equal(referencePriceOf([]), null);
  assert.equal(referencePriceOf({}), null);
  assert.equal(referencePriceOf({ referencePrice: null }), null);
  assert.equal(referencePriceOf({ referencePrice: 0 }), null, "0 is not a price");
  assert.equal(referencePriceOf({ referencePrice: -1 }), null);
  assert.equal(referencePriceOf({ referencePrice: "abc" }), null);
  assert.equal(referencePriceOf({ ReferencePrice: 1.1 }), null, "the key is exact");
});

// ═══ 6. PURITY ═════════════════════════════════════════════════════════════

test("the derivation mutates neither its rows nor its spec map", () => {
  const rows = [closedRow(), closedRow({ realisedPnl: null })];
  const cmds = [cmdRow(), cmdRow({ filledAt: null, rejectedAt: new Date() })];
  const specMap = specs();
  const rowsBefore = JSON.stringify(rows);
  const cmdsBefore = JSON.stringify(cmds);
  const specsBefore = JSON.stringify([...specMap.entries()]);

  deriveRealizedEvidence(rows, specMap);
  deriveRealizedEvidence(rows, specMap);
  deriveLiquidityEvidence(cmds);

  assert.equal(JSON.stringify(rows), rowsBefore);
  assert.equal(JSON.stringify(cmds), cmdsBefore);
  assert.equal(JSON.stringify([...specMap.entries()]), specsBefore);
});

test("the derivation is deterministic — same rows, same numbers", () => {
  const rows = [closedRow(), closedRow({ realisedPnl: -50 }), closedRow({ stopLoss: null })];
  assert.deepEqual(deriveRealizedEvidence(rows, specs()), deriveRealizedEvidence(rows, specs()));
  const cmds = [cmdRow(), cmdRow({ requestedVolume: 1, executedVolume: 0.4 })];
  assert.deepEqual(deriveLiquidityEvidence(cmds), deriveLiquidityEvidence(cmds));
});

// ═══ 7. THE SEAM: derived evidence still refuses to become a number ════════

test("derived evidence below the floors still yields NO capacity number", async () => {
  const { buildEdgeCapacityProposal } = await import("@workspace/domain/decision-intelligence");
  // Ten real, resolvable trades — genuine evidence, and still far short.
  const closed = Array.from({ length: 10 }, (_, i) =>
    closedRow({ realisedPnl: i % 3 === 0 ? -100 : 150 }));
  const realized = deriveRealizedEvidence(closed, specs());
  const liquidity = deriveLiquidityEvidence(Array.from({ length: 10 }, () => cmdRow()));
  assert.equal(realized.rMultiples.length, 10, "the derivation really did produce numbers");

  const p = buildEdgeCapacityProposal({
    edgeId: 1,
    gatheredAt: "2026-08-29T00:00:00.000Z",
    realizedRMultiples: realized.rMultiples,
    realizedReadFailure: null,
    closedPositionsAttributed: closed.length,
    closedPositionsDropped: realized.dropped,
    dispatch: liquidity.dispatch,
    dispatchReadFailure: null,
    partialFillMean01: liquidity.partialFillMean01,
    partialFillSamples: liquidity.partialFillSamples,
    slippageRSamples: liquidity.slippageRSamples,
    venueFailureObservations: { failures: realized.venueFailures, ofClosed: closed.length },
    venueFailureSlipMultiplier: null,
  });
  assert.equal(p.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(p.proposedCapacityRiskR, null);
  assert.equal(p.proposedMaxDeployedUsd, null);
  assert.equal(p.sampleSizes.rResolvableClosedTrades, 10,
    "the honest count is shown even though it is not enough");
});
