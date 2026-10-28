// /mt5/status for a shared-master user with no MT5 connection of their own
// reports the shared master bridge — re-aged now — instead of "not connected".
import { test } from "node:test";
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
