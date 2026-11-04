// EA (bridge v2) CANDLE bars arrive with openTimeEpochMs on the broker's
// trade-server clock (audit H7). The bar's time is NOT rewritten: it carries
// BROKER_SERVER time-basis evidence plus the pushing bridge's broker-clock
// offset measured from that bridge's own ticks, so a reader can show UTC and
// age the bar honestly. A bridge with no tick yet carries a null offset, and
// the chart's evidence resolver keeps the measured offset (never a UTC claim).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/bridgeV2/__qa__/candleBrokerClockEvidence.test.ts

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const { feedMarketDataStore } = await import("../ingest.js");
const { readMt5Candles, __resetMt5ProviderStore } = await import("../../data/providers/mt5Provider.js");
const { resolveCandleTimeBasisEvidence } = await import("../../data/candleTimeBasisEvidence.js");

const GMT3 = 3 * 3_600_000;
const bridgeA = { bridgeConnectionId: 7, userId: 31 };
const bridgeB = { bridgeConnectionId: 8, userId: 32 };

beforeEach(() => __resetMt5ProviderStore());

function pushCandle(bridge: { bridgeConnectionId: number; userId: number }, openTimeEpochMs: number, eaUtcMs: number) {
  feedMarketDataStore({
    messageType: "CANDLE",
    payload: { symbol: "GBPUSD", timeframe: "M5", openTimeEpochMs, open: 1.3, high: 1.31, low: 1.29, close: 1.305, volume: 10 },
    freshnessVerdict: "FRESH",
    eaCreatedAtEpochMs: eaUtcMs,
    bridge,
  });
}

test("a bar keeps its broker-clock time and carries the bridge's measured offset", () => {
  const eaUtcMs = Date.now() - 1_000;
  feedMarketDataStore({
    messageType: "TICK",
    payload: { symbol: "GBPUSD", bid: 1.3, ask: 1.3002, brokerTimeEpochMs: eaUtcMs + GMT3 },
    freshnessVerdict: "FRESH", eaCreatedAtEpochMs: eaUtcMs, bridge: bridgeA,
  });
  const brokerOpen = Math.floor((eaUtcMs + GMT3) / 300_000) * 300_000;
  pushCandle(bridgeA, brokerOpen, eaUtcMs);
  const read = readMt5Candles("GBPUSD", "M5", 10, { bridgeConnectionId: 7 });
  assert.equal(read.candles.length, 1);
  const c = read.candles[0]!;
  assert.equal(new Date(c.time).getTime(), brokerOpen, "bar time stays in broker coordinates");
  assert.equal(c.timeBasisEvidence?.kind, "unavailable");
  assert.equal(c.timeBasisEvidence?.basis, "BROKER_SERVER");
  assert.equal(c.timeBasisEvidence?.brokerClockOffsetMs, GMT3);
  assert.equal(new Date(c.timeBasisEvidence!.brokerClockOffsetMeasuredAt!).getTime(), eaUtcMs);
  assert.ok(c.timeBasisEvidence?.reason?.includes("UTC+03:00"));
  assert.equal(new Date(c.time).getTime() - c.timeBasisEvidence!.brokerClockOffsetMs!, brokerOpen - GMT3, "a reader can derive the UTC display time");
});

test("a bridge that has posted no tick gets a null offset, never another bridge's", () => {
  const eaUtcMs = Date.now() - 1_000;
  feedMarketDataStore({
    messageType: "TICK",
    payload: { symbol: "GBPUSD", bid: 1.3, ask: 1.3002, brokerTimeEpochMs: eaUtcMs + GMT3 },
    freshnessVerdict: "FRESH", eaCreatedAtEpochMs: eaUtcMs, bridge: bridgeA,
  });
  pushCandle(bridgeB, Math.floor(eaUtcMs / 300_000) * 300_000, eaUtcMs);
  const c = readMt5Candles("GBPUSD", "M5", 10, { bridgeConnectionId: 8 }).candles[0]!;
  assert.equal(c.timeBasisEvidence?.basis, "BROKER_SERVER");
  assert.equal(c.timeBasisEvidence?.brokerClockOffsetMs, null);
  assert.equal(c.timeBasisEvidence?.brokerClockOffsetMeasuredAt, null);
});

test("the chart's evidence resolver keeps the measured offset and still makes no UTC claim", () => {
  const measuredAt = new Date().toISOString();
  const kept = resolveCandleTimeBasisEvidence(
    { kind: "unavailable", basis: "BROKER_SERVER", authority: null, reason: null, brokerClockOffsetMs: GMT3, brokerClockOffsetMeasuredAt: measuredAt },
    "mt5_broker",
  );
  assert.equal(kept.kind, "unavailable");
  assert.equal(kept.basis, "BROKER_SERVER");
  assert.equal(kept.brokerClockOffsetMs, GMT3);
  assert.equal(kept.brokerClockOffsetMeasuredAt, measuredAt);
  const forged = resolveCandleTimeBasisEvidence({ kind: "original_utc", basis: "UTC", authority: "x", reason: null }, "mt5_broker");
  assert.equal(forged.kind, "unavailable", "a raw UTC claim on an MT5 bar is not accepted");
});
