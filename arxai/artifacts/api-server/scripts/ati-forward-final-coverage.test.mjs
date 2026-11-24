import assert from "node:assert/strict";
import test from "node:test";
import { reconcileFinalCoverage } from "./ati-forward-final-coverage.mjs";

function example() {
  const slots = ["priced", "gap", "missing-archive", "ungraded", null, null, null].map((id, i) => ({
    asOf: i * 900_000, receiptId: id, status: id ? "ISSUED" : "MISSED_OR_REFUSED",
    attempt: i === 4 ? null : { attemptAt: i * 900_000 + 3000 }, refusal: i === 5 ? "NO_FEED" : null,
  }));
  const snapshot = { windows: slots, verdict: "REVIEW_CONDITIONS_UNMET", costs: { cohorts: [{
    witnesses: [{ receiptId: "priced" }, { receiptId: "missing-archive" }], pricedWindows: 2,
    gaps: [{ receiptId: "gap", reason: "INCOMPLETE_TAPE" }], scoredWindows: 3,
  }] } };
  const windows = slots.map(({ receiptId, asOf }, i) => ({ receiptId, asOf: new Date(asOf).toISOString(),
    state: i === 0 ? "PRICED" : i === 1 ? "UNPRICED" : "UNVERIFIED", gap: i === 1 ? "INCOMPLETE_TAPE" : null }));
  return { snapshot, windows };
}
test("a missing scored archive stays distinct from an unscored or unissued forecast", () => {
  const { snapshot, windows } = example();
  const final = reconcileFinalCoverage(snapshot, windows);
  assert.equal(final.collectorPriced, 2);
  assert.equal(final.allScoresReplayed, false);
  assert.deepEqual(windows.map(w => w.finalDisposition), ["PRICED", "UNPRICED", "SCORED_ARCHIVE_MISSING",
    "ISSUED_WITHOUT_VERIFIED_SCORE", "NO_ATTEMPT_OR_RECEIPT", "REFUSED", "ATTEMPT_WITHOUT_RECEIPT"]);
  windows[2].state = "PRICED";
  assert.equal(reconcileFinalCoverage(snapshot, windows).allScoresReplayed, true);
});
test("collector and replay must agree on receipt identity, coverage and gap reason", () => {
  for (const change of [
    (s, w) => { w[1].gap = "NO_ISSUANCE_QUOTE"; },
    (s, w) => { w[0].state = "UNPRICED"; },
    s => { s.costs.cohorts[0].witnesses[1].receiptId = "priced"; },
    s => { s.costs.cohorts[0].gaps[0].receiptId = "outside"; },
    s => { s.windows[2].receiptId = "gap"; },
  ]) {
    const { snapshot, windows } = example();
    change(snapshot, windows);
    assert.throws(() => reconcileFinalCoverage(snapshot, windows));
  }
});
