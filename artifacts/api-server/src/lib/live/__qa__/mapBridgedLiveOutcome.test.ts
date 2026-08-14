// Unit tests for the honest bridged-live outcome mapper. Run via:
//   node --import tsx --test src/lib/live/__qa__/mapBridgedLiveOutcome.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:live-outcome-map`)
//
// The mapper is the single source of truth for turning an EA/broker terminal
// result into a Phase B outcome. The critical, safety-relevant invariant under
// test: LIVE_FILLED is returned ONLY when a confirmed broker ticket exists, so a
// "success"-looking result with no ticket can never be reported as a fill and can
// never (downstream) FULFIL an exposure reservation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapBridgedLiveOutcome } from "../liveCommandPipeline.js";

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

test("success-like status WITHOUT a broker ticket => LIVE_FAILED (never a fake fill)", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "FILLED", hasBrokerTicket: false }),
    "LIVE_FAILED",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "DONE", hasBrokerTicket: false }),
    "LIVE_FAILED",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "OK", hasBrokerTicket: false }),
    "LIVE_FAILED",
  );
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

test("fail/error statuses => LIVE_FAILED", () => {
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

test("empty / whitespace status without ticket => LIVE_FAILED (honest default)", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "", hasBrokerTicket: false }),
    "LIVE_FAILED",
  );
});
