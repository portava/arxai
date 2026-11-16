// /mt5/status for a shared-master user with no MT5 connection of their own
// reports the shared master bridge — re-aged now — instead of "not connected".
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readSharedMasterBridgeForUser, type SharedBridgeDeps } from "../mt5SharedBridgeStatus.js";

const NOW = Date.parse("2026-10-27T14:00:00Z");
function deps(over: Partial<SharedBridgeDeps> & { snapshotAgoMs?: number | null; availability?: "HEALTHY" | "RECONCILING" | "UNAVAILABLE" } = {}): SharedBridgeDeps {
  return {
    now: () => NOW,
    getEnvelope: async () => ({ accountRoutingMode: "SHARED_MASTER_MT5" }),
    getUserAllocationView: async () => ({
      pool: { lastMt5SnapshotAt: over.snapshotAgoMs == null ? null : new Date(NOW - over.snapshotAgoMs) },
      bridgeAvailability: over.availability ?? "HEALTHY",
      bridgeMessage: "Live bridge is healthy.",
    }),
    ...over,
  };
}

test("shared-master user, master heartbeating: route SHARED_MASTER and connected", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({ snapshotAgoMs: 4_000 }));
  assert.equal(out.route, "SHARED_MASTER");
  assert.equal(out.sharedMasterBridge?.connected, true);
  assert.equal(out.sharedMasterBridge?.snapshotAgeSeconds, 4);
});

test("a HEALTHY pool row whose master snapshot is old is STALE now, not connected", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({ snapshotAgoMs: 10 * 60_000 }));
  assert.equal(out.sharedMasterBridge?.availability, "STALE");
  assert.equal(out.sharedMasterBridge?.connected, false);
  assert.match(out.sharedMasterBridge!.message, /600s ago/);
});

test("user-owned routing: no shared bridge claim", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({
    getEnvelope: async () => ({ accountRoutingMode: "USER_OWNED_MT5" }),
  }));
  assert.equal(out.route, "NONE");
  assert.equal(out.sharedMasterBridge, null);
});

test("an unreadable allocation view is UNKNOWN, never connected", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({
    getUserAllocationView: async () => { throw new Error("db down (fixture)"); },
  }));
  assert.equal(out.sharedMasterBridge?.availability, "UNKNOWN");
  assert.equal(out.sharedMasterBridge?.connected, false);
});

// A routing read that failed is not "this user has no bridge". getEnvelope
// throwing, or answering its fail-closed default because the platform
// settings were unreadable, used to come back as route NONE with nothing to
// tell it from a confirmed absence, and the topbar said "MT5: OFF".
test("a routing read that throws is flagged routeReadFailed, not a confirmed NONE", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({
    getEnvelope: async () => { throw new Error("db down (fixture)"); },
  }));
  assert.equal(out.route, "NONE");
  assert.equal(out.sharedMasterBridge, null);
  assert.equal(out.routeReadFailed, true);
});

test("an envelope that says its routing is a fail-closed default is flagged routeReadFailed", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({
    getEnvelope: async () => ({ accountRoutingMode: "USER_OWNED_MT5", routingUnreadable: true }),
  }));
  assert.equal(out.route, "NONE");
  assert.equal(out.routeReadFailed, true);
});

test("a routing read that succeeded with user-owned routing is a plain NONE (no failure flag)", async () => {
  const out = await readSharedMasterBridgeForUser(5, deps({
    getEnvelope: async () => ({ accountRoutingMode: "USER_OWNED_MT5" }),
  }));
  assert.equal(out.route, "NONE");
  assert.equal(out.routeReadFailed, undefined);
});

// The production reader (no deps passed): getEnvelope answers its fail-closed
// constant when the platform settings could not be read. That object's
// USER_OWNED_MT5 routing is a default, so the read is flagged, not NONE.
test("production deps: getEnvelope's fail-closed answer is flagged routeReadFailed", async () => {
  const FAIL_CLOSED = { accountRoutingMode: "USER_OWNED_MT5" };
  let answer: { accountRoutingMode: string } = FAIL_CLOSED;
  mock.module("../../lib/adminTrading/safetyEnvelope.js", {
    namedExports: { getEnvelope: async () => answer, FAIL_CLOSED_ENVELOPE: FAIL_CLOSED },
  });
  mock.module("../../lib/live/masterBridgePool.js", {
    namedExports: { getUserAllocationView: async () => { throw new Error("not reached (fixture)"); } },
  });
  const failed = await readSharedMasterBridgeForUser(5);
  assert.equal(failed.route, "NONE");
  assert.equal(failed.routeReadFailed, true);

  // A real read of user-owned routing (a different object) is a plain NONE.
  answer = { accountRoutingMode: "USER_OWNED_MT5" };
  const read = await readSharedMasterBridgeForUser(5);
  assert.equal(read.route, "NONE");
  assert.equal(read.routeReadFailed, undefined);
});
