// Phase 6 - TTL sweep policy.
//
// The gap this closes: sweepExpiredLiveCommands is driven only by the EA poll,
// so a venue with no EA would never have its stale commands swept. The command
// would hold its exposure reservation and its idempotency slot forever, turning
// a transient timeout into a permanent lockout.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySweepCandidate, sweepOutcomeReleasesReservation,
  RECONCILE_RETRY_INTERVAL_MS, GUIDED_SWEEP_OUTCOMES,
  type SweepCandidate,
} from "@workspace/domain/safety-contracts/guidedTtlPolicy";

const NOW = "2026-08-26T12:00:00.000Z";
const base: SweepCandidate = {
  expiresAtIso: "2026-08-26T12:05:00.000Z",
  wireWritten: false, alreadyUnknown: false, lastReconcileAttemptIso: null,
};
const cls = (o: Partial<SweepCandidate> = {}, now = NOW) => classifySweepCandidate({ ...base, ...o }, now);

test("a command inside its window is left alone", () => {
  assert.equal(cls(), "LEAVE");
});

test("expired and PROVEN not transmitted fails closed", () => {
  assert.equal(cls({ expiresAtIso: "2026-08-26T11:59:00.000Z", wireWritten: false }),
    "EXPIRE_NOT_TRANSMITTED");
});

test("expired with a frame on the wire expires to UNKNOWN, not to failed", () => {
  // The whole point: an expired command that may be an open position must be
  // held for reconciliation, never written off.
  assert.equal(cls({ expiresAtIso: "2026-08-26T11:59:00.000Z", wireWritten: true }),
    "EXPIRE_TO_UNKNOWN");
});

test("only a PROVEN non-transmission releases the exposure reservation", () => {
  assert.equal(sweepOutcomeReleasesReservation("EXPIRE_NOT_TRANSMITTED"), true);
  for (const o of GUIDED_SWEEP_OUTCOMES.filter((x) => x !== "EXPIRE_NOT_TRANSMITTED")) {
    assert.equal(sweepOutcomeReleasesReservation(o), false,
      `${o} released the reservation for an order that may exist`);
  }
});

test("expiry is inclusive at the deadline", () => {
  assert.equal(cls({}, "2026-08-26T12:05:00.000Z"), "EXPIRE_NOT_TRANSMITTED");
  assert.equal(cls({}, "2026-08-26T12:04:59.999Z"), "LEAVE");
});

test("an unreadable clock or deadline never triggers an action", () => {
  assert.equal(cls({}, "not-a-date"), "LEAVE");
  assert.equal(cls({ expiresAtIso: "not-a-date" }), "LEAVE");
});

test("an UNKNOWN command is retried on an interval, and never expired again", () => {
  const u = { alreadyUnknown: true, expiresAtIso: "2026-08-26T11:00:00.000Z" };
  assert.equal(cls({ ...u, lastReconcileAttemptIso: null }), "RECONCILE_NOW");
  const justTried = new Date(Date.parse(NOW) - RECONCILE_RETRY_INTERVAL_MS + 1000).toISOString();
  assert.equal(cls({ ...u, lastReconcileAttemptIso: justTried }), "LEAVE");
  const longAgo = new Date(Date.parse(NOW) - RECONCILE_RETRY_INTERVAL_MS - 1000).toISOString();
  assert.equal(cls({ ...u, lastReconcileAttemptIso: longAgo }), "RECONCILE_NOW");
  // Critically: an already-UNKNOWN command is NEVER re-expired into a terminal
  // state by the sweeper, however long it has been stale.
  assert.notEqual(cls({ ...u, lastReconcileAttemptIso: longAgo }), "EXPIRE_NOT_TRANSMITTED");
});

test("an unreadable last-attempt time retries rather than stalling forever", () => {
  assert.equal(cls({ alreadyUnknown: true, lastReconcileAttemptIso: "not-a-date" }), "RECONCILE_NOW");
});

test("an unreadable wireWritten value is treated as possibly-transmitted", () => {
  // Polarity check: only `=== false` proves non-transmission. Anything else
  // must hold, or a garbled value would write off a live order.
  for (const weird of [undefined, null, "false", 0] as unknown[]) {
    assert.equal(
      cls({ expiresAtIso: "2026-08-26T11:59:00.000Z", wireWritten: weird as boolean }),
      "EXPIRE_TO_UNKNOWN",
      `wireWritten=${String(weird)} was read as proof of non-transmission`);
  }
});
