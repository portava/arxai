// Unit tests for the honest bridged-live outcome mapper. Run via:
//   node --import tsx --test src/lib/live/__qa__/mapBridgedLiveOutcome.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:live-outcome-map`)
//
// The mapper is the single source of truth for turning an EA/broker terminal
// result into a Phase B outcome. The critical, safety-relevant invariants:
//   * LIVE_FILLED is returned ONLY when a confirmed broker ticket exists, so a
//     "success"-looking result with no ticket can never be reported as a fill
//     and can never (downstream) FULFIL an exposure reservation.
//   * R2 S1 (audit G1b): a non-failure status with NO ticket is LIVE_UNKNOWN,
//     never LIVE_FAILED — LIVE_FAILED released the exposure reservation, and
//     if the order actually stood at the broker the master pool was
//     under-counted. UNKNOWN holds the reservation until reconciliation.
//   * Explicit fail/error/reject statuses are the EA/broker CONFIRMING
//     non-execution and stay LIVE_FAILED / LIVE_REJECTED.

// Offline pattern: importing ../liveCommandPipeline.js transitively imports
// @workspace/db, whose module init throws when DATABASE_URL is unset. A dummy
// loopback URL satisfies the init; the pg Pool is lazy and NO query is ever
// issued by these tests. (Dynamic import — a static one would hoist above
// the env stamp.)
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";

const { mapBridgedLiveOutcome } = await import("../liveCommandPipeline.js");

test("FILLED status WITH a broker ticket => LIVE_FILLED", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "FILLED", hasBrokerTicket: true }),
    "LIVE_FILLED",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "DONE", hasBrokerTicket: true }),
    "LIVE_FILLED",
  );
});

test("success-like status WITHOUT a broker ticket => LIVE_UNKNOWN (never a fake fill, never a fabricated failure)", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "FILLED", hasBrokerTicket: false }),
    "LIVE_UNKNOWN",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "DONE", hasBrokerTicket: false }),
    "LIVE_UNKNOWN",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "OK", hasBrokerTicket: false }),
    "LIVE_UNKNOWN",
  );
});

test("ambiguous success is NEVER coerced to LIVE_FAILED (audit G1b regression pin)", () => {
  // LIVE_FAILED downstream RELEASES the master exposure reservation; an
  // unproven outcome must HOLD it. If this mapping ever regresses to
  // LIVE_FAILED, the pool can be under-counted while a real order stands.
  for (const status of ["FILLED", "DONE", "OK", "COMPLETED", "SUCCESS"]) {
    const outcome = mapBridgedLiveOutcome({ status, hasBrokerTicket: false });
    assert.notEqual(outcome, "LIVE_FAILED", `${status} without ticket must not fabricate a failure`);
    assert.notEqual(outcome, "LIVE_FILLED", `${status} without ticket must not fabricate a fill`);
    assert.equal(outcome, "LIVE_UNKNOWN");
  }
});

test("rejected status => LIVE_REJECTED regardless of ticket", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "REJECTED", hasBrokerTicket: false }),
    "LIVE_REJECTED",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "REJECTED", hasBrokerTicket: true }),
    "LIVE_REJECTED",
  );
});

test("a broker 'success' retcode but REJECTED status still maps to LIVE_REJECTED (real orphan case 335/337)", () => {
  // mirror.status='REJECTED' with mt5Retcode=10009 and no ticket: status wins,
  // we never upgrade to FILLED off a retcode field.
  assert.equal(
    mapBridgedLiveOutcome({ status: "REJECTED", hasBrokerTicket: false }),
    "LIVE_REJECTED",
  );
});

test("explicit fail/error statuses => LIVE_FAILED (confirmed non-execution)", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "FAILED", hasBrokerTicket: false }),
    "LIVE_FAILED",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "ERROR", hasBrokerTicket: false }),
    "LIVE_FAILED",
  );
  // Even with a stray ticket, an explicit failure is never a fill.
  assert.equal(
    mapBridgedLiveOutcome({ status: "FAILED", hasBrokerTicket: true }),
    "LIVE_FAILED",
  );
});

test("stale (status or reason) wins over everything => STALE_COMMAND_REJECTED", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "STALE", hasBrokerTicket: false }),
    "STALE_COMMAND_REJECTED",
  );
  assert.equal(
    mapBridgedLiveOutcome({
      status: "FILLED",
      reason: "STALE_COMMAND",
      hasBrokerTicket: true,
    }),
    "STALE_COMMAND_REJECTED",
  );
});

test("empty / whitespace status without ticket => LIVE_UNKNOWN (no proof of anything)", () => {
  // An unparseable status with no ticket proves neither execution nor
  // non-execution — the only honest answer is UNKNOWN.
  assert.equal(
    mapBridgedLiveOutcome({ status: "", hasBrokerTicket: false }),
    "LIVE_UNKNOWN",
  );
});
