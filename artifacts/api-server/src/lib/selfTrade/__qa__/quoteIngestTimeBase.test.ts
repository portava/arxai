// Bridge v2 TICK → quote store → entry observation: the time base.
//
// The EA stamps two clocks on every tick: the payload's `brokerTimeEpochMs`
// (MQL5 `MqlTick.time_msc`, the trade server's wall clock encoded as epoch ms,
// which equals UTC only on a GMT+0 server) and the envelope's
// `eaCreatedAtEpochMs` (MQL5 `TimeGMT`, UTC) taken in the same call. The stored
// quote's observation time must be the UTC one; the broker clock is kept as a
// diagnostic. Offline: the database module is replaced, the in-memory store and
// the real feed function are exercised; no network, broker or venue is reached.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as realInstruments from "../../instruments/index.js";

mock.module("@workspace/db", {
  namedExports: { db: {}, bridgeV2EventsTable: {}, bridgeV2StreamStateTable: {} },
});
// No registry here: the symbol resolves to itself (forex-style no-op).
mock.module("../../instruments/index.js", {
  namedExports: { ...realInstruments, resolveBrokerSymbolName: async (stored: string) => stored },
});
mock.module("../../mt5/brokerSymbolSpec.js", {
  namedExports: {
    getBrokerSymbolSpec: async () => ({ hasBrokerTruth: true, spec: { point: 0.00001 } }),
  },
});
const { feedMarketDataStore } = await import("../../bridgeV2/ingest.js");
const { mt5Provider, readMt5Quote, __resetMt5ProviderStore } = await import(
  "../../data/providers/mt5Provider.js"
);
const { observeAgentEntryMarket } = await import("../entryMarketObservation.js");
const { evaluateEntryFreshFacts } = await import("../freshFacts.js");

const EA_UTC = Date.parse("2026-10-27T12:00:00.000Z");
const HOURS_3 = 3 * 3_600_000;
// The authenticated bridge the route attributes the push to, and the dispatch
// context that reads it back.
const BRIDGE = { bridgeConnectionId: 7, userId: 9 };
const CTX = { bridgeConnectionId: 7, bridgeUserId: 9, eaVersion: "1.54" };
const tick = (brokerTimeEpochMs: unknown) => ({
  symbol: "EURUSD",
  bid: 1.1,
  ask: 1.1001,
  brokerTimeEpochMs,
});
function feed(payload: unknown, eaCreatedAtEpochMs: unknown, freshnessVerdict = "LIVE") {
  feedMarketDataStore({
    messageType: "TICK",
    payload,
    freshnessVerdict,
    eaCreatedAtEpochMs,
    bridge: BRIDGE,
  });
}
// The feed's previous post: a different tick two seconds earlier on the same
// broker clock offset, so the tick under test is bounded (quoteTickProvenance
// .test.ts covers the unbounded cases).
const prime = (offsetMs: number) =>
  feed({ ...tick(EA_UTC - 2_000 + offsetMs), bid: 1.0999, ask: 1.1 }, EA_UTC - 2_000);
const stored = () => readMt5Quote("EURUSD", { bridgeConnectionId: 7 }).quote;
async function claimVerdict(nowMs = EA_UTC + 1_000) {
  const observation = await observeAgentEntryMarket(9, "EURUSD", CTX);
  const v = evaluateEntryFreshFacts({
    side: "BUY",
    stopLoss: 1.09,
    thesis: { entryZone: { from: 1.1, to: 1.1001 } },
    observation,
    nowMs,
  });
  return { observation, v, reason: v.ok ? "OK" : v.reason };
}

beforeEach(() => __resetMt5ProviderStore());

describe("quote time base at ingest", () => {
  it("a GMT+3 trade server: the stored time is the EA's UTC clock, the offset is recorded", async () => {
    prime(HOURS_3);
    feed(tick(EA_UTC + HOURS_3), EA_UTC);
    const q = stored();
    assert.equal(q?.timestamp, "2026-10-27T12:00:00.000Z");
    assert.equal(q?.brokerClockMs, EA_UTC + HOURS_3);
    assert.equal(q?.brokerClockOffsetMs, HOURS_3);
    const { v, observation, reason } = await claimVerdict();
    assert.equal(reason, "OK");
    assert.equal(observation.brokerClockOffsetMs, HOURS_3);
    if (v.ok) {
      assert.equal(v.facts.quoteAgeMs, 1_000);
      assert.equal(v.facts.brokerClockOffsetMs, HOURS_3);
    }
  });
  it("a GMT-3 trade server passes on the UTC stamp as well", async () => {
    prime(-HOURS_3);
    feed(tick(EA_UTC - HOURS_3), EA_UTC);
    const q = stored();
    assert.equal(q?.timestamp, "2026-10-27T12:00:00.000Z");
    assert.equal(q?.brokerClockOffsetMs, -HOURS_3);
    const { v, reason } = await claimVerdict();
    assert.equal(reason, "OK");
    if (v.ok) assert.equal(v.facts.brokerClockOffsetMs, -HOURS_3);
  });
  it("a GMT+0 trade server records a zero offset", async () => {
    prime(0);
    feed(tick(EA_UTC), EA_UTC);
    assert.equal(stored()?.brokerClockOffsetMs, 0);
    assert.equal((await claimVerdict()).reason, "OK");
  });
  it("the UTC stamp is still subject to the age bounds (no loosening)", async () => {
    prime(HOURS_3);
    feed(tick(EA_UTC + HOURS_3), EA_UTC);
    assert.equal((await claimVerdict(EA_UTC + 5_001)).reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.equal((await claimVerdict(EA_UTC - 5_001)).reason, "ENTRY_FRESH_QUOTE_FUTURE_DATED");
  });
  for (const eaCreatedAt of [undefined, null, NaN, 0, -1, Infinity, "1761566400000", {}]) {
    it(`a missing or malformed EA clock (${typeof eaCreatedAt === "string" ? JSON.stringify(eaCreatedAt) : String(eaCreatedAt)}) stores nothing (fail closed)`, async () => {
      feed(tick(EA_UTC + HOURS_3), eaCreatedAt);
      assert.equal(stored(), null);
      const { observation, reason } = await claimVerdict();
      assert.equal(observation.error, "BROKER_QUOTE_UNAVAILABLE");
      assert.equal(reason, "ENTRY_FRESH_QUOTE_UNAVAILABLE");
    });
  }
  it("server receive time is never used: no quote is stamped 'now'", async () => {
    const before = Date.now();
    feed(tick(before + HOURS_3), EA_UTC);
    assert.equal(Date.parse(stored()?.timestamp ?? ""), EA_UTC);
  });
  it("a tick without a broker clock still stores the UTC time with null diagnostics", async () => {
    feed(tick(undefined), EA_UTC);
    const q = stored();
    assert.equal(q?.timestamp, "2026-10-27T12:00:00.000Z");
    assert.equal(q?.brokerClockMs, null);
    assert.equal(q?.brokerClockOffsetMs, null);
  });
  it("a transport-STALE tick is still dropped", async () => {
    feed(tick(EA_UTC), EA_UTC, "STALE");
    assert.equal(stored(), null);
  });
  it("the unscoped chart/scanner read sees the same UTC stamp (one time base for every reader)", async () => {
    feed(tick(EA_UTC + HOURS_3), EA_UTC);
    const q = await mt5Provider.getQuote("EURUSD");
    assert.equal(q.timestamp, "2026-10-27T12:00:00.000Z");
    assert.equal(q.brokerClockOffsetMs, HOURS_3);
  });
});
