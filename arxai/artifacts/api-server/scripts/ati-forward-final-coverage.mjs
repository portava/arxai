// Reconcile the collector's final result with the offline quote-window replay.
import assert from "node:assert/strict";

export function missedIssuance(slot) {
  if (slot.status !== "MISSED_OR_REFUSED") return null;
  assert.equal(slot.receiptId, null);
  assert.ok(!slot.refusal || slot.attempt);
  if (slot.refusal) return "REFUSED";
  return slot.attempt ? "ATTEMPT_WITHOUT_RECEIPT" : "NO_ATTEMPT_OR_RECEIPT";
}

export function reconcileFinalCoverage(snapshot, windows) {
  const issuedIds = new Set();
  for (const slot of snapshot.windows) {
    if (slot.status === "ISSUED") {
      assert.ok(slot.receiptId && !issuedIds.has(slot.receiptId) && slot.attempt && !slot.refusal);
      issuedIds.add(slot.receiptId);
    } else {
      assert.ok(missedIssuance(slot));
    }
  }
  const expected = new Map();
  let reportedPriced = 0;
  for (const cohort of snapshot.costs.cohorts) {
    assert.equal(cohort.witnesses.length, cohort.pricedWindows);
    assert.equal(cohort.gaps.length + cohort.witnesses.length, cohort.scoredWindows);
    reportedPriced += cohort.pricedWindows;
    for (const row of [...cohort.witnesses, ...cohort.gaps]) {
      assert.ok(issuedIds.has(row.receiptId) && !expected.has(row.receiptId));
      expected.set(row.receiptId, row);
    }
  }
  assert.equal(windows.length, snapshot.windows.length);
  const dispositions = {};
  let replayedScores = 0;
  for (const [index, window] of windows.entries()) {
    const slot = snapshot.windows[index];
    assert.equal(window.receiptId, slot.receiptId);
    assert.equal(Date.parse(window.asOf), slot.asOf);
    const witness = expected.get(slot.receiptId);
    let disposition;
    if (window.state === "UNVERIFIED") {
      if (witness) disposition = "SCORED_ARCHIVE_MISSING";
      else if (slot.receiptId) disposition = "ISSUED_WITHOUT_VERIFIED_SCORE";
      else disposition = missedIssuance(slot);
    } else {
      assert.ok(witness, "The replayed forecast is absent from the collector's scores");
      assert.equal(window.state, witness.reason ? "UNPRICED" : "PRICED");
      assert.equal(window.gap ?? null, witness.reason ?? null);
      replayedScores++;
      disposition = window.state;
    }
    window.finalDisposition = disposition;
    dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
  }
  return { collectorVerdict: snapshot.verdict, issued: issuedIds.size, scored: expected.size,
    collectorPriced: reportedPriced, allScoresReplayed: replayedScores === expected.size, dispositions };
}
