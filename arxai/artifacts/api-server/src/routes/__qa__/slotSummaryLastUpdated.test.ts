// GET /api/me/live/slot-summary — "Last update" is the time the broker last
// reported the book, not the time the server answered.
//
// The defect this locks: lastUpdated was new Date() on every response, so with
// a bridge that last heartbeated 40 minutes ago the card read "Stale" next to
// "Last update: <now>", and the Open Trades panel "Last refresh: <now>".
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/slotSummaryLastUpdated.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { getSlotSummary, installSlotSummaryMocks, positionRow, state } from "./slotSummaryHarness.js";

await installSlotSummaryMocks();

const FORTY_MIN = 40 * 60_000;

test("stale bridge: lastUpdated is the broker's last report, not the response time", async () => {
  const then = new Date(Date.now() - FORTY_MIN);
  state.bridge = { id: 3, leverage: 100, lastHeartbeat: then, lastPositionsSnapshotAt: then };
  state.positions = [positionRow({ lastSyncedAt: then })];
  const s = await getSlotSummary();
  assert.equal(s["dataFreshness"], "STALE");
  assert.equal(s["lastUpdated"], then.toISOString());
  assert.ok(Math.abs(Date.parse(String(s["servedAt"])) - Date.now()) < 5_000, "servedAt carries the response time");
});

test("nothing ever reported: lastUpdated is null, not now", async () => {
  state.bridge = null;
  state.positions = [];
  const s = await getSlotSummary();
  assert.equal(s["dataFreshness"], "MISSING");
  assert.equal(s["lastUpdated"], null);
});

test("a newer row sync than the sweep marker wins", async () => {
  const sweep = new Date(Date.now() - 60_000);
  const row = new Date(Date.now() - 2_000);
  state.bridge = { id: 3, leverage: 100, lastHeartbeat: new Date(), lastPositionsSnapshotAt: sweep };
  state.positions = [positionRow({ lastSyncedAt: row })];
  const s = await getSlotSummary();
  assert.equal(s["lastUpdated"], row.toISOString());
});
