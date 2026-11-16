// Truth audit T2 (2026-11-04): the chart feed is the requesting trader's own
// bridge when it is pushing the series; another bridge's MT5 series may still be
// served but is LABELLED platform_shared, and two bridges pushing at once is
// named as contention. Drives the real router and the real in-memory MT5 store
// with a 24/7 synthetic symbol (no session-profile DB read).
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx --test \
//        src/lib/data/chart/__qa__/chartFeedScope.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getChartCandles } from "../chartDataService.js";
import {
  __resetMt5ProviderStore,
  __setMt5ContentionWarnSink,
  updateCandlesFromMT5,
  updateQuoteFromMT5,
} from "../../providers/mt5Provider.js";
import { __resetFormingBarStore } from "../formingBarComposer.js";

const M5 = 300_000;
const SYMBOL = "V75";

function bars(priceBase: number, now: number) {
  const latestOpen = Math.floor(now / M5) * M5 - M5; // the just-closed bar
  return Array.from({ length: 60 }, (_, i) => {
    const t = latestOpen - (59 - i) * M5;
    const p = priceBase + i * 0.1;
    return { time: new Date(t).toISOString(), open: p, high: p + 0.5, low: p - 0.5, close: p + 0.1, volume: 10 };
  });
}

beforeEach(() => {
  __resetMt5ProviderStore();
  __resetFormingBarStore();
  __setMt5ContentionWarnSink(() => {});
});

test("own bridge pushing: the trader's series is served and labelled own_bridge", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(1000, now), "M5", { bridgeConnectionId: 11, userId: 1 });
  updateCandlesFromMT5(SYMBOL, bars(2000, now), "M5", { bridgeConnectionId: 22, userId: 2 });
  const own = await getChartCandles(SYMBOL, "M5", 50, false, { bridgeConnectionId: 11 });
  assert.equal(own.source, "mt5_broker");
  assert.equal(own.feedStatus.feedScope, "own_bridge");
  assert.ok(own.candles.at(-1)!.close < 1500, "bridge 11's prices, not the most recent writer's");
  assert.equal(own.feedStatus.contention, true, "two attributed bridges are pushing this series");
});

test("own bridge silent: the platform series is served but labelled platform_shared", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(2000, now), "M5", { bridgeConnectionId: 22, userId: 2 });
  const shared = await getChartCandles(SYMBOL, "M5", 50, false, { bridgeConnectionId: 99 });
  assert.equal(shared.source, "mt5_broker");
  assert.equal(shared.feedStatus.feedScope, "platform_shared");
  assert.equal(shared.feedStatus.contention, false);
});

test("no requesting bridge: an MT5 series is platform_shared; nothing served is null", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(2000, now), "M5", { bridgeConnectionId: 22, userId: 2 });
  const anon = await getChartCandles(SYMBOL, "M5", 50, false);
  assert.equal(anon.feedStatus.feedScope, "platform_shared");
  __resetMt5ProviderStore();
  const none = await getChartCandles("R_75_UNKNOWN_SERIES", "M5", 50, false);
  assert.equal(none.feedStatus.feedScope ?? null, none.source == null ? null : none.feedStatus.feedScope);
});

test("the last tick is the writer's own: a converted producer tick time is labelled producer_tick, a raw one server_receive", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(1000, now), "M5", { bridgeConnectionId: 11, userId: 1 });
  updateQuoteFromMT5(SYMBOL, { symbol: SYMBOL, bid: 1005, ask: 1005.2, spread: 0.2, timestamp: new Date(now - 500).toISOString() },
    { bridgeConnectionId: 11, userId: 1 }, { tickTimeObserved: true, brokerClockOffsetMs: 7_200_000 });
  // The forming-bar store has seen no tick for this writer's source, so there is
  // no "last tick" to report at all: the basis must be null, never invented.
  const own = await getChartCandles(SYMBOL, "M5", 50, false, { bridgeConnectionId: 11 });
  assert.equal(own.feedStatus.brokerClockOffsetMs, null, "no clock sample recorded for bridge 11 in this test");
  assert.equal(own.feedStatus.lastTickTime == null, own.feedStatus.lastTickTimeBasis == null);
});
