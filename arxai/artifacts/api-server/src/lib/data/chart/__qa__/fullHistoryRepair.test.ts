import test from "node:test";
import assert from "node:assert/strict";
import { advanceHistoryPage, brokerHistoryIdentity } from "../../brokerHistoryPolicy.js";
import { computeBackfillStatus } from "../../brokerCandleStore.js";

const start = Date.parse("2020-06-01T00:00:00Z");
const page = { priorCursor: null, priorComplete: false, oldestRawMs: start,
  oldestCloseRawMs: start + 60_000, newestRawMs: start + 199 * 60_000,
  accepted: 200, rejected: 0, sent: 200 };
test("two distant endpoints and a depth target cannot claim full history", () => {
  assert.equal(computeBackfillStatus({ barsStored: 2, oldestStoredAt: new Date(start),
    newestStoredAt: new Date(start + 3650 * 86400000), targetDays: 365,
    lastIngestAt: new Date() }).status, "PARTIAL");
});
test("live receipt does not pretend historical import is progressing", () => {
  assert.equal(computeBackfillStatus({ barsStored: 200, oldestStoredAt: new Date(start),
    newestStoredAt: new Date(), targetDays: 365, lastIngestAt: new Date() }).status, "PARTIAL");
});
test("seed starts its own chain even if older disconnected rows exist", () => {
  const progress = advanceHistoryPage({ ...page, proof: { kind: "seed", requestedBars: 200,
    copiedBars: 200, serverFirstRawMs: start - 1e9, boundaryReached: false } });
  assert.equal(progress.cursor?.getTime(), start - 1000); assert.equal(progress.complete, false);
});
test("partial acknowledgement, hydration and stale cursors cannot advance", () => {
  const proof = { kind: "backfill" as const, requestedBars: 200, copiedBars: 200,
    requestedEndRawMs: page.newestRawMs, serverFirstRawMs: start - 1e9, boundaryReached: false };
  for (const change of [{ rejected: 1 }, { accepted: 199 }, { sent: 199 }, { priorCursor: new Date(start) }]) {
    const result = advanceHistoryPage({ ...page, priorCursor: new Date(page.newestRawMs), proof, ...change });
    assert.equal(result.advanced, false);
  }
});
test("calendar boundary requires the native first available instant inside the first candle", () => {
  const proof = { kind: "seed" as const, requestedBars: 200, copiedBars: 2,
    serverFirstRawMs: start + 3 * 86400000, boundaryReached: true };
  const p = advanceHistoryPage({ ...page, accepted: 2, sent: 2, newestRawMs: start + 31 * 86400000,
    oldestCloseRawMs: start + 30 * 86400000, proof });
  assert.equal(p.complete, true); assert.equal(p.cursor, null);
  assert.equal(advanceHistoryPage({ ...page, proof: { ...proof, copiedBars: 200 } }).complete, false);
});
test("account/server changes create a new immutable history partition", () => {
  const id = { userId: 1, bridgeConnectionId: 5, accountNumber: "A", serverName: "X", clockBasis: "broker_server" };
  assert.notEqual(brokerHistoryIdentity(id), brokerHistoryIdentity({ ...id, accountNumber: "B" }));
  assert.notEqual(brokerHistoryIdentity(id), brokerHistoryIdentity({ ...id, serverName: "Y" }));
  assert.notEqual(brokerHistoryIdentity(id), brokerHistoryIdentity({ ...id, userId: 2 }));
});
