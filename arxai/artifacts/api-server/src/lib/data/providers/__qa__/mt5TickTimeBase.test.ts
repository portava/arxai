// Real in-memory quote producer and quote-binding checker. No DB, network or EA.
// Receiving a repeat proves transport activity, not a fresh market tick.
import { afterEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  __resetMt5ProviderStore, recordMt5Tick, readMt5Quote, CANDLE_TTL_MS,
  type Mt5TickInput,
} from "../mt5Provider.js";
import { bindBrokerQuote, observationFromMt5Quote } from "../../chart/brokerQuoteBinding.js";
import { MAX_FUTURE_CLOCK_SKEW_MS, QUOTE_FRESH_TTL_MS } from "../../freshness.js";

const NOW = Date.UTC(2026, 10, 13, 12);
const A = { bridgeConnectionId: 9101, userId: 81 };
const B = { bridgeConnectionId: 9102, userId: 82 };
const SYMBOL = "EURUSD";
const native = "EURUSD.a";
function clock(t: TestContext) {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  return (value: number) => { now = value; };
}
function tick(eaUtcMs = NOW, overrides: Partial<Mt5TickInput> = {}): Mt5TickInput {
  return { bid: 1.1, ask: 1.1002, brokerSymbol: native, brokerTimeMs: eaUtcMs + 7_200_000, eaUtcMs, ...overrides };
}
const own = () => readMt5Quote(SYMBOL, { bridgeConnectionId: A.bridgeConnectionId });
function binding(now = NOW) {
  return bindBrokerQuote({
    series: { providerId: "mt5_broker", subProviderId: null, ...A, environment: "unknown", brokerSymbol: native },
    quote: observationFromMt5Quote(own()), requestingUserId: A.userId, now,
  });
}
afterEach(() => __resetMt5ProviderStore());

test("a first post preserves broker diagnostics but cannot claim an observed fresh tick", t => {
  clock(t);
  const proof = recordMt5Tick(SYMBOL, tick(), A);
  const read = own()!;
  assert.equal(read.quote.timestamp, new Date(NOW).toISOString());
  assert.equal(read.quote.brokerClockMs, NOW + 7_200_000);
  assert.equal(read.quote.brokerClockOffsetMs, 7_200_000);
  assert.equal(read.brokerClockOffsetMs, null, "EA first-sight UTC is not a converted broker timestamp");
  assert.deepEqual(proof, { firstSeenEaMs: NOW, lastPostedEaMs: NOW, reposts: 0, priorPostEaMs: null });
  assert.equal(read.tickTimeObserved, false);
  assert.deepEqual(binding().reasons, ["QUOTE_TIME_UNKNOWN"]);
});

test("a different tick tightly bounded by an earlier same-writer post becomes observed", t => {
  const advance = clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  advance(NOW + 1_000);
  const proof = recordMt5Tick(SYMBOL, tick(NOW + 1_000, { bid: 1.1001, ask: 1.1003 }), A);
  assert.equal(own()!.tickTimeObserved, true);
  assert.deepEqual(proof, { firstSeenEaMs: NOW + 1_000, lastPostedEaMs: NOW + 1_000, reposts: 0, priorPostEaMs: NOW });
  assert.equal(binding(NOW + 1_000).status, "BOUND");
});

test("reposting an identical tick never freshens its original observed timestamp", t => {
  const advance = clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  const observed = tick(NOW + 1_000, { bid: 1.1001, ask: 1.1003 });
  advance(NOW + 1_000);
  recordMt5Tick(SYMBOL, observed, A);
  const later = NOW + 1_001 + QUOTE_FRESH_TTL_MS;
  advance(later);
  recordMt5Tick(SYMBOL, { ...observed, eaUtcMs: later }, A);
  assert.equal(own()!.receivedAtMs, later);
  assert.equal(own()!.quote.timestamp, new Date(NOW + 1_000).toISOString());
  assert.equal(own()!.tick?.reposts, 1);
  assert.equal(own()!.tick?.lastPostedEaMs, later);
  assert.equal(binding(later).status, "STALE");
  assert.deepEqual(binding(later).reasons, ["QUOTE_STALE"]);
});

test("an unbounded first tick stays unverified even after many fresh reposts", t => {
  const advance = clock(t);
  const old = tick();
  recordMt5Tick(SYMBOL, old, A);
  for (const elapsed of [1_000, 2_000, 3_000]) {
    advance(NOW + elapsed);
    recordMt5Tick(SYMBOL, { ...old, eaUtcMs: NOW + elapsed }, A);
  }
  assert.equal(own()!.tickTimeObserved, false);
  assert.equal(own()!.tick?.firstSeenEaMs, NOW);
  assert.equal(own()!.tick?.reposts, 3);
  assert.deepEqual(binding(NOW + 3_000).reasons, ["QUOTE_TIME_UNKNOWN"]);
});

test("a new tick after a long EA posting gap does not acquire freshness from receipt", t => {
  const advance = clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  advance(NOW + QUOTE_FRESH_TTL_MS + 1);
  recordMt5Tick(SYMBOL, tick(NOW + QUOTE_FRESH_TTL_MS + 1), A);
  assert.equal(own()!.tickTimeObserved, false);
});

test("an expired server-side partition cannot lend a prior-post bound", t => {
  const advance = clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  advance(NOW + CANDLE_TTL_MS + 1);
  assert.equal(own(), null);
  // A restarted/replayed producer reports an apparently short EA gap, but the
  // server knows the partition was silent beyond its own retention budget.
  recordMt5Tick(SYMBOL, tick(NOW + 1_000), A);
  assert.equal(own()!.tickTimeObserved, false);
});

test("a backward EA clock and a missing broker tick clock remain unverified", t => {
  clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  recordMt5Tick(SYMBOL, tick(NOW - 1_000), A);
  assert.equal(own()!.tickTimeObserved, false);
  recordMt5Tick(SYMBOL, tick(NOW + 1_000, { brokerTimeMs: null }), A);
  assert.equal(own()!.tickTimeObserved, false);
  assert.deepEqual(binding().reasons, ["QUOTE_TIME_UNKNOWN"]);
});

test("the exact freshness boundary is admitted; the next millisecond is not", t => {
  const advance = clock(t);
  for (const gap of [QUOTE_FRESH_TTL_MS, QUOTE_FRESH_TTL_MS + 1]) {
    __resetMt5ProviderStore();
    advance(NOW);
    recordMt5Tick(SYMBOL, tick(), A);
    advance(NOW + gap);
    recordMt5Tick(SYMBOL, tick(NOW + gap), A);
    assert.equal(own()!.tickTimeObserved, gap === QUOTE_FRESH_TTL_MS);
  }
});

test("fresh posting does not validate a producer time beyond the future-skew allowance", t => {
  clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  recordMt5Tick(SYMBOL, tick(NOW + MAX_FUTURE_CLOCK_SKEW_MS + 1), A);
  assert.equal(own()!.tickTimeObserved, true, "the posting gap is observed separately from UTC validity");
  assert.deepEqual(binding().reasons, ["QUOTE_TIME_FUTURE"]);
  assert.equal(binding().status, "STALE");
});

test("another bridge's posts cannot bound or supply the requesting bridge's quote", t => {
  clock(t);
  recordMt5Tick(SYMBOL, tick(), B);
  recordMt5Tick(SYMBOL, tick(NOW + 1_000), A);
  assert.equal(own()!.tickTimeObserved, false);
  assert.equal(own()!.userId, A.userId);
  assert.equal(own()!.tick?.priorPostEaMs, null);
  assert.equal(readMt5Quote(SYMBOL, { bridgeConnectionId: 9199 }), null);
  const wrong = bindBrokerQuote({
    series: { providerId: "mt5_broker", subProviderId: null, ...A, environment: "unknown", brokerSymbol: native },
    quote: observationFromMt5Quote(readMt5Quote(SYMBOL, { bridgeConnectionId: B.bridgeConnectionId })),
    requestingUserId: A.userId, now: NOW,
  });
  assert.equal(wrong.status, "MISMATCH");
  assert.ok(wrong.reasons.includes("BRIDGE_MISMATCH"));
  assert.ok(wrong.reasons.includes("OWNER_MISMATCH"));
  assert.ok(wrong.reasons.includes("ACCOUNT_NOT_REQUESTER"));
});

test("changing the native broker symbol resets the first-sight bound", t => {
  const advance = clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  advance(NOW + 1_000);
  recordMt5Tick(SYMBOL, tick(NOW + 1_000, { brokerSymbol: "EURUSD.b" }), A);
  assert.equal(own()!.tickTimeObserved, false);
  assert.equal(own()!.tick?.priorPostEaMs, null);
  assert.ok(binding(NOW + 1_000).reasons.includes("BROKER_SYMBOL_MISMATCH"));
});

test("an unattributed producer cannot inherit a bridge or owner from an earlier writer", t => {
  clock(t);
  recordMt5Tick(SYMBOL, tick(), A);
  recordMt5Tick(SYMBOL, tick(NOW + 1_000), null);
  const anonymous = readMt5Quote(SYMBOL, { writer: { bridgeConnectionId: null } })!;
  assert.equal(anonymous.bridgeConnectionId, null);
  assert.equal(anonymous.userId, null);
  assert.equal(anonymous.tickTimeObserved, false);
  assert.equal(anonymous.tick?.priorPostEaMs, null);
  assert.equal(own()!.bridgeConnectionId, A.bridgeConnectionId);
});
