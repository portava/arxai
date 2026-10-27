// The entry quote must come from the user's own bridge. The mt5_broker quote
// store is partitioned by the authenticated bridge connection that pushed the
// tick (the same Mt5BridgeIdentity wall the candle store uses); the entry
// observation reads only the dispatch bridge's partition. Offline: the database
// module is replaced, the real in-memory store and ingest feed are exercised.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("@workspace/db", {
  namedExports: { db: {}, bridgeV2EventsTable: {}, bridgeV2StreamStateTable: {} },
});
mock.module("../../instruments/brokerSymbolName.js", {
  namedExports: { resolveBrokerSymbolName: async (stored: string) => stored },
});
mock.module("../../mt5/brokerSymbolSpec.js", {
  namedExports: {
    getBrokerSymbolSpec: async () => ({ hasBrokerTruth: true, spec: { point: 0.00001 } }),
  },
});
const { feedMarketDataStore } = await import("../../bridgeV2/ingest.js");
const {
  mt5Provider,
  updateQuoteFromMT5,
  readMt5Quote,
  getMt5QuoteAvailability,
  __resetMt5ProviderStore,
} = await import("../../data/providers/mt5Provider.js");
const { observeAgentEntryMarket } = await import("../entryMarketObservation.js");
const { evaluateEntryFreshFacts } = await import("../freshFacts.js");

const EA_UTC = Date.parse("2026-10-27T12:00:00.000Z");
const quote = (bid: number) => ({
  symbol: "EURUSD",
  bid,
  ask: bid + 0.0001,
  timestamp: "2026-10-27T12:00:00.000Z",
});
async function verdict(bridgeConnectionId: number | null | undefined) {
  const observation = await observeAgentEntryMarket(
    9,
    "EURUSD",
    bridgeConnectionId === undefined ? undefined : { bridgeConnectionId },
  );
  const v = evaluateEntryFreshFacts({
    side: "BUY",
    stopLoss: 1.09,
    thesis: { entryZone: { from: 1.1, to: 1.1002 } },
    observation,
    nowMs: EA_UTC + 1_000,
  });
  return { observation, reason: v.ok ? "OK" : v.reason };
}

beforeEach(() => __resetMt5ProviderStore());

describe("quote store bridge partitions", () => {
  it("a scoped read serves only that bridge's quote, not the most recent writer", () => {
    updateQuoteFromMT5("EURUSD", quote(1.1), { bridgeConnectionId: 1, userId: 9 });
    updateQuoteFromMT5("EURUSD", quote(1.2), { bridgeConnectionId: 2, userId: 10 });
    const one = readMt5Quote("EURUSD", { bridgeConnectionId: 1 });
    assert.equal(one.quote?.bid, 1.1);
    assert.equal(one.bridgeConnectionId, 1);
    assert.equal(one.userId, 9);
    assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 2 }).quote?.bid, 1.2);
  });
  it("a bridge that never pushed the symbol reads nothing, even when another bridge is fresh", () => {
    updateQuoteFromMT5("EURUSD", quote(1.1), { bridgeConnectionId: 2, userId: 10 });
    const r = readMt5Quote("EURUSD", { bridgeConnectionId: 1 });
    assert.equal(r.quote, null);
    assert.equal(r.bridgeConnectionId, null);
  });
  it("an unattributed legacy write is never served to a scoped read", () => {
    updateQuoteFromMT5("EURUSD", quote(1.1));
    assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 1 }).quote, null);
  });
  it("a scoped read honours the store TTL", () => {
    updateQuoteFromMT5("EURUSD", quote(1.1), { bridgeConnectionId: 1 });
    assert.equal(
      readMt5Quote("EURUSD", { bridgeConnectionId: 1, now: Date.now() + 5 * 60_000 + 1 }).quote,
      null,
    );
  });
  it("the symbol key is still trim+uppercase on both sides, exact otherwise", () => {
    updateQuoteFromMT5(" eurusd ", quote(1.1), { bridgeConnectionId: 1 });
    assert.equal(readMt5Quote("EURUSD", { bridgeConnectionId: 1 }).quote?.bid, 1.1);
    assert.equal(readMt5Quote("EURUSD.r", { bridgeConnectionId: 1 }).quote, null);
  });
  it("unscoped legacy consumers keep seeing the most recent writer", async () => {
    updateQuoteFromMT5("EURUSD", quote(1.1), { bridgeConnectionId: 1 });
    updateQuoteFromMT5("EURUSD", quote(1.2));
    updateQuoteFromMT5("EURUSD", quote(1.3), { bridgeConnectionId: 2 });
    assert.equal((await mt5Provider.getQuote("EURUSD")).bid, 1.3);
    const avail = getMt5QuoteAvailability("EURUSD");
    assert.equal(avail.hasQuote, true);
    assert.equal(avail.hasPrice, true);
    assert.equal(getMt5QuoteAvailability("GBPUSD").hasQuote, false);
  });
});

describe("entry observation is bound to the dispatch bridge", () => {
  const tick = { symbol: "EURUSD", bid: 1.1, ask: 1.1001, brokerTimeEpochMs: EA_UTC };
  it("the ingest feed attributes the tick to the authenticated bridge and the claim passes on it", async () => {
    feedMarketDataStore({
      messageType: "TICK",
      payload: tick,
      freshnessVerdict: "LIVE",
      eaCreatedAtEpochMs: EA_UTC,
      bridge: { bridgeConnectionId: 7, userId: 9 },
    });
    const { observation, reason } = await verdict(7);
    assert.equal(reason, "OK");
    assert.equal(observation.bridgeConnectionId, 7);
  });
  it("another user's bridge quoting the same symbol does not satisfy this user's claim", async () => {
    feedMarketDataStore({
      messageType: "TICK",
      payload: tick,
      freshnessVerdict: "LIVE",
      eaCreatedAtEpochMs: EA_UTC,
      bridge: { bridgeConnectionId: 8, userId: 10 },
    });
    const { observation, reason } = await verdict(7);
    assert.equal(observation.error, "BROKER_QUOTE_UNAVAILABLE");
    assert.equal(reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
  it("an unattributed push (no bridge on the connection) does not satisfy a bridge-bound claim", async () => {
    feedMarketDataStore({
      messageType: "TICK",
      payload: tick,
      freshnessVerdict: "LIVE",
      eaCreatedAtEpochMs: EA_UTC,
      bridge: null,
    });
    assert.equal((await verdict(7)).reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
  it("a dispatch without a bridge identity refuses rather than reading any bridge's quote", async () => {
    updateQuoteFromMT5("EURUSD", quote(1.1), { bridgeConnectionId: 7, userId: 9 });
    const { observation, reason } = await verdict(null);
    assert.equal(observation.error, "BROKER_QUOTE_BRIDGE_UNKNOWN");
    assert.equal(reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
  });
});
