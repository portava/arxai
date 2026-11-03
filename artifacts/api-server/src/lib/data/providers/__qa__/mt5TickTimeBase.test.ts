// Bridge v2 TICK time base (PR #100 port onto the chart chain).
//
// The EA's `brokerTimeEpochMs` is MQL5 `MqlTick.time_msc`: the trade server's
// wall clock, which is UTC only on a GMT+0 broker. Before this port the quote
// store stamped it as the quote's UTC timestamp, so on a GMT+3 broker every
// quote read three hours in the future (always "fresh"), and on a GMT-5 broker
// five hours stale. The quote timestamp must be the EA's own UTC clock from the
// envelope (`eaCreatedAtEpochMs`), with the broker clock kept as a diagnostic.
//
// Offline: in-memory store only. DATABASE_URL dummy satisfies @workspace/db
// module init, which lib/bridgeV2/ingest.ts imports transitively; no query runs.
//
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx --test --test-force-exit \
//        src/lib/data/providers/__qa__/mt5TickTimeBase.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetMt5ProviderStore, readMt5Quote, recordMt5Tick } from "../mt5Provider.js";
import { feedMarketDataStore } from "../../../bridgeV2/ingest.js";

const GMT3 = 3 * 3_600_000;
const bridge = { bridgeConnectionId: 7, userId: 31 };

beforeEach(() => __resetMt5ProviderStore());

test("a tick is stamped with the EA UTC clock, never the broker server clock", () => {
  const eaUtcMs = Date.UTC(2026, 10, 3, 12, 0, 0);
  const brokerTimeMs = eaUtcMs + GMT3; // GMT+3 trade server
  recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1002, brokerTimeMs, eaUtcMs }, bridge);
  const read = readMt5Quote("EURUSD", { bridgeConnectionId: 7 });
  assert.ok(read.quote, "quote stored");
  assert.equal(new Date(read.quote!.timestamp).getTime(), eaUtcMs);
  assert.equal(read.quote!.brokerClockMs, brokerTimeMs);
  assert.equal(read.quote!.brokerClockOffsetMs, GMT3);
});

test("an identical re-post keeps the first-sight stamp; a new tick moves it", () => {
  const t0 = Date.UTC(2026, 10, 3, 12, 0, 0);
  recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1002, brokerTimeMs: t0 + GMT3, eaUtcMs: t0 }, bridge);
  const repost = recordMt5Tick("EURUSD", { bid: 1.1, ask: 1.1002, brokerTimeMs: t0 + GMT3, eaUtcMs: t0 + 5_000 }, bridge);
  assert.equal(repost.reposts, 1);
  assert.equal(new Date(readMt5Quote("EURUSD", { bridgeConnectionId: 7 }).quote!.timestamp).getTime(), t0);
  recordMt5Tick("EURUSD", { bid: 1.1001, ask: 1.1003, brokerTimeMs: t0 + GMT3 + 9_000, eaUtcMs: t0 + 9_000 }, bridge);
  assert.equal(new Date(readMt5Quote("EURUSD", { bridgeConnectionId: 7 }).quote!.timestamp).getTime(), t0 + 9_000);
});

test("the ingest feed uses the envelope EA clock and stores nothing without it", () => {
  const eaUtcMs = Date.UTC(2026, 10, 3, 12, 0, 0);
  feedMarketDataStore({
    messageType: "TICK",
    payload: { symbol: "GBPUSD", bid: 1.3, ask: 1.3002, brokerTimeEpochMs: eaUtcMs + GMT3 },
    freshnessVerdict: "FRESH",
    eaCreatedAtEpochMs: eaUtcMs,
    bridge,
  });
  const read = readMt5Quote("GBPUSD", { bridgeConnectionId: 7 });
  assert.equal(new Date(read.quote!.timestamp).getTime(), eaUtcMs);
  assert.equal(read.quote!.brokerClockOffsetMs, GMT3);

  feedMarketDataStore({
    messageType: "TICK",
    payload: { symbol: "USDJPY", bid: 150.1, ask: 150.12, brokerTimeEpochMs: eaUtcMs + GMT3 },
    freshnessVerdict: "FRESH",
    eaCreatedAtEpochMs: undefined, // no EA clock → no server-clock fallback, nothing stored
    bridge,
  });
  assert.equal(readMt5Quote("USDJPY", { bridgeConnectionId: 7 }).quote, null);
});
