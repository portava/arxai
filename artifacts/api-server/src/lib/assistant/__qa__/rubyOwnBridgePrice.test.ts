// The price a Ruby watch may act on (sweep 2026-11-04): a fresh observed tick
// from the watch owner's OWN bridge only. routeQuote is stubbed; the test
// proves the read is pinned and that a quote attributed to another writer,
// the unattributed partition or a third-party provider is refused.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls: Array<{ symbol: string; opts: unknown }> = [];
let next: unknown = null;
mock.module("@workspace/db", { namedExports: { db: {}, rubyCommandsTable: {} } });
mock.module("drizzle-orm", { namedExports: { eq: () => ({}) } });
mock.module("../../tradeEngine/pipeline.js", { namedExports: { submitInstantTrade: async () => { throw new Error("not in this test"); } } });
mock.module("../../handshake/coordinator.js", { namedExports: { runHandshake: async () => ({ aggregateStatus: "OK" }) } });
mock.module("../../pgError.js", { namedExports: { isUniqueViolation: () => false } });
mock.module("../../data/marketDataRouter.js", {
  namedExports: { routeQuote: async (symbol: string, opts: unknown) => { calls.push({ symbol, opts }); return next; } },
});

const { ownBridgePriceOf } = await import("../rubyExecution.js");

const fresh = () => ({ bid: 1.1, ask: 1.1002, timestamp: new Date(Date.now() - 1000).toISOString() });
const quote = (prov: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
  ok: true, quote: fresh(), tickTimeObserved: true, primaryProvider: String(prov?.["providerId"] ?? "x"), provenance: prov, ...over,
});

test("own bridge, fresh observed tick → mid price; the read is pinned to that writer", async () => {
  next = quote({ providerId: "mt5_broker", bridgeConnectionId: 42 });
  const p = await ownBridgePriceOf("EURUSD", 42);
  assert.ok(p != null && Math.abs(p - 1.1001) < 1e-9);
  assert.deepEqual(calls.at(-1), { symbol: "EURUSD", opts: { mt5Writer: { bridgeConnectionId: 42 } } });
});

test("no own bridge → null without reading anything", async () => {
  const before = calls.length;
  assert.equal(await ownBridgePriceOf("EURUSD", null), null);
  assert.equal(calls.length, before);
});

test("another writer, the unattributed partition or a third-party provider → null", async () => {
  for (const prov of [
    { providerId: "mt5_broker", bridgeConnectionId: 99 },
    { providerId: "mt5_broker", bridgeConnectionId: null },
    { providerId: "assistant_real", bridgeConnectionId: null },
    undefined,
  ]) {
    next = quote(prov);
    assert.equal(await ownBridgePriceOf("EURUSD", 42), null, JSON.stringify(prov));
  }
});

test("own bridge but stale or unobserved tick → null", async () => {
  next = quote({ providerId: "mt5_broker", bridgeConnectionId: 42 }, { tickTimeObserved: false });
  assert.equal(await ownBridgePriceOf("EURUSD", 42), null);
  next = quote({ providerId: "mt5_broker", bridgeConnectionId: 42 }, { quote: { bid: 1.1, ask: 1.1, timestamp: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(await ownBridgePriceOf("EURUSD", 42), null);
});
