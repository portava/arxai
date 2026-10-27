// Bridge v2 TICK → quote store → entry claim: what the 5 s age bound measures.
//
// The Universal Agent re-posts `SymbolInfoTick`'s LAST tick on every 2 s sweep
// whether or not it changed, and stamps the envelope's `eaCreatedAtEpochMs` at
// send time. On a closed market the broker's final quote is therefore pushed
// again and again with an ever-newer EA clock. Stamping the stored quote from
// the EA clock of the *latest* post would make the claim measure "time since
// the EA last re-posted its cached tick", not tick age, and a Friday-close tick
// would pass on Saturday. The store must stamp a tick at the EA time it was
// FIRST seen in that bridge's partition, keep that stamp across identical
// re-posts, and the claim must refuse a tick whose occurrence cannot be
// bounded by an earlier post of the same feed. Offline: the database module is
// replaced; the real store, feed function, observer and evaluator run.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as realInstruments from "../../instruments/index.js";

mock.module("@workspace/db", {
  namedExports: { db: {}, bridgeV2EventsTable: {}, bridgeV2StreamStateTable: {} },
});
mock.module("../../instruments/index.js", {
  namedExports: { ...realInstruments, resolveBrokerSymbolName: async (stored: string) => stored },
});
mock.module("../../mt5/brokerSymbolSpec.js", {
  namedExports: {
    getBrokerSymbolSpec: async () => ({ hasBrokerTruth: true, spec: { point: 0.00001 } }),
  },
});
const { feedMarketDataStore } = await import("../../bridgeV2/ingest.js");
const { mt5Provider, readMt5Quote, updateQuoteFromMT5, __resetMt5ProviderStore } = await import(
  "../../data/providers/mt5Provider.js"
);
const { observeAgentEntryMarket } = await import("../entryMarketObservation.js");
const { evaluateEntryFreshFacts } = await import("../freshFacts.js");

const T0 = Date.parse("2026-10-27T12:00:00.000Z");
const HOURS_3 = 3 * 3_600_000;
const BRIDGE = { bridgeConnectionId: 7, userId: 9 };
const CTX = { bridgeConnectionId: 7, bridgeUserId: 9, eaVersion: "1.54" };
const iso = (ms: number) => new Date(ms).toISOString();

// One EA post: the tick payload (broker clock + prices) and the EA's UTC clock
// at send time. `brokerOffset` is the trade server's offset from UTC.
function post(
  eaUtcMs: number,
  tick: { bid: number; ask?: number; brokerTimeMs?: number | null | undefined },
  bridge = BRIDGE,
) {
  const payload: Record<string, unknown> = {
    symbol: "EURUSD",
    bid: tick.bid,
    ask: tick.ask ?? tick.bid + 0.0001,
  };
  if (tick.brokerTimeMs !== undefined) payload.brokerTimeEpochMs = tick.brokerTimeMs;
  feedMarketDataStore({
    messageType: "TICK",
    payload,
    freshnessVerdict: "LIVE",
    eaCreatedAtEpochMs: eaUtcMs,
    bridge,
  });
}
const stored = (bridgeConnectionId = 7) => readMt5Quote("EURUSD", { bridgeConnectionId });
async function claim(nowMs: number, ctx: Record<string, unknown> = CTX) {
  const observation = await observeAgentEntryMarket(9, "EURUSD", ctx as never);
  const v = evaluateEntryFreshFacts({
    side: "BUY",
    stopLoss: 1.09,
    thesis: { entryZone: { from: 1.1, to: 1.1003 } },
    observation,
    nowMs,
  });
  return {
    observation,
    v,
    reason: v.ok ? "OK" : v.reason,
    detail: v.ok ? "" : v.detail,
    facts: v.ok ? v.facts : null,
  };
}

beforeEach(() => __resetMt5ProviderStore());

describe("a tick is stamped when it is first seen, not when it is re-posted", () => {
  it("the broker's frozen last tick re-posted every 2 s keeps its first-seen time and goes STALE after 5 s", async () => {
    // Live tick A, then tick B which becomes the market's last tick.
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 + HOURS_3 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 + HOURS_3 });
    // The EA keeps re-posting B with a newer EA clock.
    for (const t of [T0 + 2_000, T0 + 4_000, T0 + 6_000]) post(t, { bid: 1.1001, brokerTimeMs: T0 + HOURS_3 });
    const q = stored();
    assert.equal(q.quote?.timestamp, iso(T0), "stored time is the first sight of tick B");
    assert.deepEqual(q.tick, {
      firstSeenEaMs: T0,
      lastPostedEaMs: T0 + 6_000,
      reposts: 3,
      priorPostEaMs: T0 - 2_000,
    });
    const r = await claim(T0 + 6_500);
    assert.equal(r.reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.match(r.detail, /age 6500ms > max 5000ms/);
  });
  it("inside the window the same re-posted tick passes, and the audit counts the re-posts", async () => {
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 + HOURS_3 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 + HOURS_3 });
    post(T0 + 2_000, { bid: 1.1001, brokerTimeMs: T0 + HOURS_3 });
    const r = await claim(T0 + 2_500);
    assert.equal(r.reason, "OK");
    assert.equal(r.facts?.quoteAgeMs, 2_500);
    assert.equal(r.facts?.quoteReposts, 1);
    assert.equal(r.facts?.quoteFeedGapMs, 2_000);
    assert.equal(r.facts?.brokerClockOffsetMs, HOURS_3);
  });
  it("the recorded broker-clock offset is the one at first sight (a re-post does not drift it)", () => {
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 + HOURS_3 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 + HOURS_3 });
    post(T0 + 4_000, { bid: 1.1001, brokerTimeMs: T0 + HOURS_3 });
    assert.equal(stored().quote?.brokerClockOffsetMs, HOURS_3);
    assert.equal(stored().quote?.brokerClockMs, T0 + HOURS_3);
  });
  it("a changed price on the same broker clock is a new tick", () => {
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    post(T0 + 2_000, { bid: 1.1002, brokerTimeMs: T0 });
    assert.equal(stored().quote?.timestamp, iso(T0 + 2_000));
    assert.equal(stored().quote?.bid, 1.1002);
    assert.equal(stored().tick?.reposts, 0);
    assert.equal(stored().tick?.priorPostEaMs, T0);
  });
  it("a changed ask alone is a new tick too", () => {
    post(T0, { bid: 1.1, ask: 1.1001, brokerTimeMs: T0 });
    post(T0 + 2_000, { bid: 1.1, ask: 1.1002, brokerTimeMs: T0 });
    assert.equal(stored().quote?.timestamp, iso(T0 + 2_000));
  });
  it("a tick without a broker clock is identified by its prices", () => {
    post(T0, { bid: 1.1, brokerTimeMs: null });
    post(T0 + 2_000, { bid: 1.1, brokerTimeMs: null });
    assert.equal(stored().quote?.timestamp, iso(T0));
    assert.equal(stored().tick?.reposts, 1);
    post(T0 + 4_000, { bid: 1.1001, brokerTimeMs: null });
    assert.equal(stored().quote?.timestamp, iso(T0 + 4_000));
  });
  it("the unscoped chart/scanner read sees the first-seen stamp as well", async () => {
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    post(T0 + 30_000, { bid: 1.1001, brokerTimeMs: T0 });
    assert.equal((await mt5Provider.getQuote("EURUSD")).timestamp, iso(T0));
  });
  it("a re-post refreshes the store TTL (the feed is alive even when the market is not)", () => {
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    const wall = Date.now();
    assert.notEqual(readMt5Quote("EURUSD", { bridgeConnectionId: 7, now: wall + 60_000 }).quote, null);
  });
});

describe("the claim refuses a tick whose occurrence no earlier post bounds", () => {
  it("the first tick a bridge ever posts for a symbol is refused STALE (it may be the broker's frozen last quote)", async () => {
    // A GMT+0 server's Friday-close tick, first seen by a freshly started
    // server on Saturday. The base refused it STALE on the broker clock; the
    // EA-clock stamp alone would pass it with quoteAgeMs = 1000.
    const fridayClose = T0 - 40 * 3_600_000;
    post(T0, { bid: 1.1001, brokerTimeMs: fridayClose });
    assert.equal(stored().tick?.priorPostEaMs, null);
    const r = await claim(T0 + 1_000);
    assert.equal(r.reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.match(r.detail, /tick age unbounded/);
    assert.match(r.detail, new RegExp(`first seen ${iso(T0)}`));
    assert.match(r.detail, /no earlier post/);
  });
  it("re-posting that first tick never proves it", async () => {
    const fridayClose = T0 - 40 * 3_600_000;
    post(T0, { bid: 1.1001, brokerTimeMs: fridayClose });
    post(T0 + 2_000, { bid: 1.1001, brokerTimeMs: fridayClose });
    // Inside the age window of the first sight: still unbounded.
    const soon = await claim(T0 + 2_500);
    assert.equal(soon.reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.match(soon.detail, /tick age unbounded/);
    assert.match(soon.detail, new RegExp(`re-posted 1 time to ${iso(T0 + 2_000)}`));
    // Long after it: plain age, measured from the first sight, not the re-post.
    post(T0 + 30_000, { bid: 1.1001, brokerTimeMs: fridayClose });
    const late = await claim(T0 + 31_000);
    assert.equal(late.reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.match(late.detail, /^age 31000ms > max 5000ms$/);
  });
  it("a tick that follows a long silence of the feed is refused: it may have occurred anywhere in the gap", async () => {
    // Friday: live tick A, then the terminal is shut down. Sunday: the EA comes
    // back and posts the (different) close tick C for the first time.
    const friday = T0 - 40 * 3_600_000;
    post(friday, { bid: 1.1, brokerTimeMs: friday });
    post(T0, { bid: 1.1001, brokerTimeMs: friday + 1_000 });
    const r = await claim(T0 + 1_000);
    assert.equal(r.reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.match(r.detail, /tick age unbounded/);
    assert.match(r.detail, /previous post .*144000000ms before/);
  });
  it("a feed gap at the 5 s bound is accepted, one millisecond more is not", async () => {
    post(T0 - 5_000, { bid: 1.1, brokerTimeMs: T0 - 5_000 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    assert.equal((await claim(T0 + 1_000)).reason, "OK");
    __resetMt5ProviderStore();
    post(T0 - 5_001, { bid: 1.1, brokerTimeMs: T0 - 5_001 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    assert.equal((await claim(T0 + 1_000)).reason, "ENTRY_FRESH_QUOTE_STALE");
  });
  it("the second distinct tick in a live feed is trusted from its own first sight", async () => {
    post(T0, { bid: 1.1, brokerTimeMs: T0 + HOURS_3 });
    assert.equal((await claim(T0 + 1_000)).reason, "ENTRY_FRESH_QUOTE_STALE");
    post(T0 + 2_000, { bid: 1.1001, brokerTimeMs: T0 + 2_000 + HOURS_3 });
    const r = await claim(T0 + 3_000);
    assert.equal(r.reason, "OK");
    assert.equal(r.facts?.quoteAgeMs, 1_000);
    assert.equal(r.facts?.quoteReposts, 0);
    assert.equal(r.facts?.quoteFeedGapMs, 2_000);
  });
  it("weekend end to end: live Friday, frozen Saturday, fresh again at the Monday open", async () => {
    const close = Date.parse("2026-10-23T20:59:59.000Z");
    post(close - 2_000, { bid: 1.1, brokerTimeMs: close - 2_000 });
    post(close, { bid: 1.1001, brokerTimeMs: close });
    assert.equal((await claim(close + 1_000)).reason, "OK");
    // Saturday: the EA sweeps on, re-posting the close tick.
    const saturday = Date.parse("2026-10-24T12:00:00.000Z");
    for (let t = saturday; t <= saturday + 10_000; t += 2_000) post(t, { bid: 1.1001, brokerTimeMs: close });
    const sat = await claim(saturday + 10_500);
    assert.equal(sat.reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.match(sat.detail, /^age \d+ms > max 5000ms$/);
    // Monday open: a new tick two seconds after the last re-post.
    const monday = Date.parse("2026-10-26T00:00:02.000Z");
    post(monday - 2_000, { bid: 1.1001, brokerTimeMs: close });
    post(monday, { bid: 1.1004, brokerTimeMs: monday });
    const mon = await claim(monday + 1_000);
    assert.equal(mon.reason, "OK");
    assert.equal(mon.facts?.quoteAgeMs, 1_000);
  });
  it("another bridge's earlier tick does not bound this bridge's tick (partitions keep their own history)", async () => {
    const other = { bridgeConnectionId: 8, userId: 10 };
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 }, other);
    post(T0, { bid: 1.1001, brokerTimeMs: T0 }, other);
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    assert.equal((await claim(T0 + 1_000)).reason, "ENTRY_FRESH_QUOTE_STALE");
    assert.equal(stored(8).tick?.priorPostEaMs, T0 - 2_000);
  });
  it("a quote written without tick provenance is never trusted by the claim", async () => {
    updateQuoteFromMT5(
      "EURUSD",
      { symbol: "EURUSD", bid: 1.1, ask: 1.1001, timestamp: iso(T0) },
      { bridgeConnectionId: 7, userId: 9 },
    );
    assert.equal(stored().tick, null);
    const r = await claim(T0 + 1_000);
    assert.equal(r.observation.tickProvenance, null);
    assert.equal(r.reason, "ENTRY_FRESH_QUOTE_TIMESTAMP_INVALID");
    assert.match(r.detail, /no tick provenance/);
  });
  it("the observation carries the provenance verbatim for the audit", async () => {
    post(T0 - 2_000, { bid: 1.1, brokerTimeMs: T0 - 2_000 });
    post(T0, { bid: 1.1001, brokerTimeMs: T0 });
    post(T0 + 2_000, { bid: 1.1001, brokerTimeMs: T0 });
    const { observation } = await claim(T0 + 2_500);
    assert.deepEqual(observation.tickProvenance, {
      firstSeenAt: iso(T0),
      lastPostedAt: iso(T0 + 2_000),
      reposts: 1,
      priorPostAt: iso(T0 - 2_000),
    });
    assert.equal(observation.observedAt, iso(T0));
  });
});
