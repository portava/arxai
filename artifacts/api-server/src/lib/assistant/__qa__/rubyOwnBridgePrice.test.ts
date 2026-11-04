// The price a Ruby watch may act on (sweep 2026-11-04): a fresh observed tick
// from the watch owner's OWN bridge only. On this line the read is the pinned
// MT5 store read (readMt5Quote with the bridge id), which serves exactly that
// bridge's partition; the test proves another writer, an empty partition or a
// stale (re-posted) tick are refused.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls: Array<{ symbol: string; opts: unknown }> = [];
let next: { quote: unknown; bridgeConnectionId: number | null; userId: number | null; tick: unknown } = { quote: null, bridgeConnectionId: null, userId: null, tick: null };
mock.module("@workspace/db", { namedExports: { db: {}, rubyCommandsTable: {} } });
mock.module("drizzle-orm", { namedExports: { eq: () => ({}), and: () => ({}), or: () => ({}), asc: () => ({}), desc: () => ({}), lt: () => ({}), lte: () => ({}), gt: () => ({}), gte: () => ({}), ne: () => ({}), inArray: () => ({}), isNull: () => ({}), isNotNull: () => ({}), sql: Object.assign(() => ({}), { raw: () => ({}) }) } });
mock.module("../../tradeEngine/pipeline.js", { namedExports: { submitInstantTrade: async () => { throw new Error("not in this test"); } } });
mock.module("../../handshake/coordinator.js", { namedExports: { runHandshake: async () => ({ aggregateStatus: "OK" }) } });
mock.module("../../pgError.js", { namedExports: { isUniqueViolation: () => false } });
mock.module("../boundQuote.js", { namedExports: { boundQuotePrice: () => null } });
mock.module("../../data/marketDataRouter.js", { namedExports: { routeQuote: async () => null } });
mock.module("../../data/providers/mt5Provider.js", {
  namedExports: { readMt5Quote: (symbol: string, opts: unknown) => { calls.push({ symbol, opts }); return next; } },
});

const { ownBridgePriceOf } = await import("../rubyExecution.js");

const fresh = (ageMs = 1000) => ({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: new Date(Date.now() - ageMs).toISOString() });
const read = (bridgeConnectionId: number | null, quote: unknown = fresh()) =>
  ({ quote, bridgeConnectionId, userId: bridgeConnectionId == null ? null : 1, tick: null });

test("own bridge, fresh observed tick → mid price; the read is pinned to that bridge", async () => {
  next = read(42);
  const p = await ownBridgePriceOf("EURUSD", 42);
  assert.ok(p != null && Math.abs(p - 1.1001) < 1e-9);
  assert.deepEqual(calls.at(-1), { symbol: "EURUSD", opts: { bridgeConnectionId: 42 } });
});

test("no own bridge → null without reading anything", async () => {
  const before = calls.length;
  assert.equal(await ownBridgePriceOf("EURUSD", null), null);
  assert.equal(calls.length, before);
});

test("another writer's partition or an empty partition → null", async () => {
  next = read(99);
  assert.equal(await ownBridgePriceOf("EURUSD", 42), null, "other bridge");
  next = read(null, null);
  assert.equal(await ownBridgePriceOf("EURUSD", 42), null, "empty partition");
});

test("own bridge but a stale (re-posted) tick → null", async () => {
  next = read(42, fresh(5 * 60_000));
  assert.equal(await ownBridgePriceOf("EURUSD", 42), null);
  next = read(42, { symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: "not-a-time" });
  assert.equal(await ownBridgePriceOf("EURUSD", 42), null);
});
