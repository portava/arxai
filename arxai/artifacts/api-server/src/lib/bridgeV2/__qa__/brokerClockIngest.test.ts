// Truth audit T1 (2026-11-04), convert-at-ingest (owner decision 2026-11-08):
// v2 CANDLE stamps arrive in the broker's clock and are converted to UTC with
// the bridge's measured offset (here measured from a tick's broker time against
// the envelope's GMT clock); with no measurement the raw stamp is kept and
// labelled BROKER_SERVER. A v2 TICK is stamped with the EA's own UTC clock at
// first sight (recordMt5Tick), so its time never depends on the offset.
// No database: drives the market-data fold directly.
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx --test \
//        src/lib/bridgeV2/__qa__/brokerClockIngest.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __feedMarketDataStoreForTests as feed } from "../ingest.js";

const fold = (messageType: string, payload: unknown, freshnessVerdict: string | null,
  bridge: { bridgeConnectionId: number; userId: number } | null, eaCreatedAtEpochMs: number | null) =>
  feed({ messageType, payload, freshnessVerdict, bridge, eaCreatedAtEpochMs });
import { __resetBrokerClockOffsets, getBrokerClockOffset } from "../../brokerHub/brokerClockOffset.js";
import { __resetMt5ProviderStore, readMt5Candles, readMt5Quote } from "../../data/providers/mt5Provider.js";
import { __resetFormingBarStore, getFormingBar } from "../../data/chart/formingBarComposer.js";

const H = 3_600_000;
const BRIDGE = { bridgeConnectionId: 41, userId: 9 };

beforeEach(() => {
  __resetBrokerClockOffsets();
  __resetMt5ProviderStore();
  __resetFormingBarStore();
});

test("UTC+2 broker: the tick is a clock sample, stamped on the EA's UTC clock; the tip buckets on UTC", () => {
  const now = Date.now();
  const gmt = now - 50; // EA's GMT clock when it sent the tick
  const brokerTick = gmt + 2 * H - 120; // the tick's broker-clock time, 120 ms before send
  fold("TICK", { symbol: "EURUSD", bid: 1.1, ask: 1.1001, brokerTimeEpochMs: brokerTick }, "FRESH", BRIDGE, gmt);

  const off = getBrokerClockOffset(41, now);
  assert.ok(off, "the tick pair is a clock sample");
  assert.equal(off.offsetMs, 2 * H);
  assert.equal(off.basis, "v2_tick");

  const q = readMt5Quote("EURUSD", { bridgeConnectionId: 41, now });
  assert.ok(q);
  assert.equal(Date.parse(q.quote.timestamp), gmt, "first sight on the EA's UTC clock");

  // The forming tip buckets by the converted time, so it sits in the current interval.
  const tip = getFormingBar("EURUSD", "M5", now, "mt5_broker", 41);
  assert.ok(tip);
  assert.equal(tip.openMs, Math.floor((brokerTick - 2 * H) / 300_000) * 300_000);
});

test("no measurement: a closed bar keeps its raw broker stamp, labelled BROKER_SERVER with no offset", () => {
  const now = Date.now();
  const gmt = now - 10;
  // 20 minutes off the 30-minute grid: rejected as a clock sample.
  fold("TICK", { symbol: "GBPUSD", bid: 1.3, ask: 1.3001, brokerTimeEpochMs: gmt + 2 * H + 20 * 60_000 }, "FRESH", BRIDGE, gmt);
  assert.equal(getBrokerClockOffset(41, now), null);
  const barOpenBroker = Math.floor((now + 2 * H) / 300_000) * 300_000 - 300_000;
  fold("CANDLE", { symbol: "GBPUSD", timeframe: "M5", openTimeEpochMs: barOpenBroker, open: 1.3, high: 1.31, low: 1.29, close: 1.3, volume: 3 }, "FRESH", BRIDGE, gmt);
  const read = readMt5Candles("GBPUSD", "M5", 10, { bridgeConnectionId: 41, now });
  assert.equal(read.candles.length, 1);
  assert.equal(Date.parse(read.candles[0]!.time), barOpenBroker, "raw stamp (consumers fail closed)");
  const ev = read.candles[0]!.timeBasisEvidence;
  assert.equal(ev?.basis, "BROKER_SERVER");
  assert.equal(ev?.brokerClockOffsetMs, null);
});

test("UTC-5 broker: closed bars pushed after the offset is known open at their UTC time", () => {
  const now = Date.now();
  const gmt = now - 10;
  fold("TICK", { symbol: "XAUUSD", bid: 2400, ask: 2400.5, brokerTimeEpochMs: gmt - 5 * H }, "FRESH", BRIDGE, gmt);
  const barOpenBroker = Math.floor((now - 5 * H) / 300_000) * 300_000 - 300_000; // the just-closed M5 bar, broker clock
  fold("CANDLE", { symbol: "XAUUSD", timeframe: "M5", openTimeEpochMs: barOpenBroker, open: 2399, high: 2401, low: 2398, close: 2400, volume: 12 }, "FRESH", BRIDGE, gmt);
  const read = readMt5Candles("XAUUSD", "M5", 10, { bridgeConnectionId: 41, now });
  assert.equal(read.candles.length, 1);
  assert.equal(Date.parse(read.candles[0]!.time), barOpenBroker + 5 * H, "bar open converted to UTC");
  const ev = read.candles[0]!.timeBasisEvidence;
  assert.equal(ev?.basis, "UTC");
  assert.equal(ev?.convertedAtIngest, true);
  assert.equal(ev?.kind, "unavailable", "a measured offset is never an original UTC record");
  assert.equal(ev?.brokerClockOffsetMs, -5 * H);
  assert.equal(read.futureStamped, false);
});

test("an unattributed writer measures and converts on its own key, never on an attributed bridge's", () => {
  const now = Date.now();
  const gmt = now - 5;
  fold("TICK", { symbol: "USDJPY", bid: 150, ask: 150.01, brokerTimeEpochMs: gmt + 3 * H }, "FRESH", null, gmt);
  assert.equal(getBrokerClockOffset(null, now)?.offsetMs, 3 * H);
  assert.equal(getBrokerClockOffset(41, now), null);
  const q = readMt5Quote("USDJPY", { now });
  assert.ok(q);
  assert.equal(q.bridgeConnectionId, null);
  assert.equal(Date.parse(q.quote.timestamp), gmt);
});
