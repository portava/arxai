// Truth banners (2026-11-04): every read made inside a signed-in request is
// pinned to that reader's own bridge — the chart feed, the router's candles and
// quotes, the chart intelligence cache — so the AI read, the scanner and the
// chart on one page describe the same series. Outside a scope nothing changes.
// Drives the real router and the in-memory MT5 store with a 24/7 synthetic symbol.
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx --test \
//        src/lib/data/__qa__/feedScopeRequestPin.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { routeCandles, routeQuote } from "../marketDataRouter.js";
import { getChartCandles } from "../chart/chartDataService.js";
import { feedScopeForUser, fixedFeedScope, runWithFeedScope, currentFeedScopeBridge, feedScopeCacheKey } from "../feedScope.js";
import {
  __resetMt5ProviderStore,
  __setMt5ContentionWarnSink,
  updateCandlesFromMT5,
  updateQuoteFromMT5,
} from "../providers/mt5Provider.js";
import { __resetFormingBarStore } from "../chart/formingBarComposer.js";

const M5 = 300_000;
const SYMBOL = "V75";

function bars(priceBase: number, now: number) {
  const latestOpen = Math.floor(now / M5) * M5 - M5;
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

test("the scope resolves the reader's bridge once and is absent outside a request", async () => {
  let lookups = 0;
  const scope = feedScopeForUser(7, async () => { lookups++; return 11; });
  assert.equal(await currentFeedScopeBridge(), null, "no scope outside a request");
  await runWithFeedScope(scope, async () => {
    assert.equal(await currentFeedScopeBridge(), 11);
    assert.equal(await currentFeedScopeBridge(), 11);
    assert.equal(scope.resolvedBridgeConnectionId(), 11);
  });
  assert.equal(lookups, 1);
  assert.equal(feedScopeForUser(null, async () => 5).resolvedBridgeConnectionId(), null, "anonymous = platform scope");
  const failing = feedScopeForUser(8, async () => { throw new Error("db down"); });
  assert.equal(await failing.bridgeConnectionId(), null, "a failed lookup is no bridge, never a throw");
  assert.equal(feedScopeCacheKey(null), "shared");
  assert.equal(feedScopeCacheKey(22), "bridge:22");
});

test("inside a reader's scope an unpinned routeCandles serves the reader's own series, not the newest writer's", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(1000, now), "M5", { bridgeConnectionId: 11, userId: 1 });
  updateCandlesFromMT5(SYMBOL, bars(2000, now), "M5", { bridgeConnectionId: 22, userId: 2 });

  const platform = await routeCandles(SYMBOL, "M5", 50);
  assert.equal(platform.ok, true);
  assert.ok(platform.candles.at(-1)!.close > 1500, "outside a scope: the most recent writer, as before");

  const own = await runWithFeedScope(fixedFeedScope(11, 1), () => routeCandles(SYMBOL, "M5", 50));
  assert.equal(own.ok, true);
  assert.ok(own.candles.at(-1)!.close < 1500, "bridge 11's bars");
  assert.equal(own.provenance?.bridgeConnectionId, 11);

  // An explicit platform-wide read inside the scope stays platform-wide.
  const explicit = await runWithFeedScope(fixedFeedScope(11, 1), () => routeCandles(SYMBOL, "M5", 50, { bridgeConnectionId: null }));
  assert.ok(explicit.candles.at(-1)!.close > 1500);
});

test("a reader whose bridge is not pushing the series falls back to the platform series, attributed to its writer", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(2000, now), "M5", { bridgeConnectionId: 22, userId: 2 });
  const r = await runWithFeedScope(fixedFeedScope(99, 9), () => routeCandles(SYMBOL, "M5", 50));
  assert.equal(r.ok, true);
  assert.equal(r.primaryProvider, "mt5_broker");
  assert.equal(r.provenance?.bridgeConnectionId, 22, "the real writer, never the reader");
  assert.equal(r.attempts.filter((a) => a.provider === "mt5_broker").length, 2, "pinned miss, then shared hit");

  const feed = await runWithFeedScope(fixedFeedScope(99, 9), () => getChartCandles(SYMBOL, "M5", 50, false));
  assert.equal(feed.feedStatus.feedScope, "platform_shared", "the chart feed labels the fallback even with no explicit pin");
});

test("the chart feed built with no explicit pin inside the scope is own_bridge, like the chart route's", async () => {
  const now = Date.now();
  updateCandlesFromMT5(SYMBOL, bars(1000, now), "M5", { bridgeConnectionId: 11, userId: 1 });
  updateCandlesFromMT5(SYMBOL, bars(2000, now), "M5", { bridgeConnectionId: 22, userId: 2 });
  const implicit = await runWithFeedScope(fixedFeedScope(11, 1), () => getChartCandles(SYMBOL, "M5", 50, false));
  const explicit = await getChartCandles(SYMBOL, "M5", 50, false, { bridgeConnectionId: 11 });
  assert.equal(implicit.feedStatus.feedScope, "own_bridge");
  assert.equal(implicit.candles.at(-1)!.close, explicit.candles.at(-1)!.close, "the AI/scanner read and the chart route see the same bars");
  assert.equal(implicit.feedStatus.contention, true);
});

test("inside the scope an unpinned routeQuote is the reader's own writer's quote, with the platform quote as fallback", async () => {
  const now = Date.now();
  updateQuoteFromMT5(SYMBOL, { symbol: SYMBOL, bid: 1005, ask: 1005.2, spread: 0.2, timestamp: new Date(now - 500).toISOString() }, { bridgeConnectionId: 11, userId: 1 });
  updateQuoteFromMT5(SYMBOL, { symbol: SYMBOL, bid: 2005, ask: 2005.2, spread: 0.2, timestamp: new Date(now - 200).toISOString() }, { bridgeConnectionId: 22, userId: 2 });

  const platform = await routeQuote(SYMBOL);
  assert.equal(platform.quote?.bid, 2005, "outside a scope: the most recent writer");
  const own = await runWithFeedScope(fixedFeedScope(11, 1), () => routeQuote(SYMBOL));
  assert.equal(own.quote?.bid, 1005);
  assert.equal(own.provenance?.bridgeConnectionId, 11);
  const stranger = await runWithFeedScope(fixedFeedScope(99, 9), () => routeQuote(SYMBOL));
  assert.equal(stranger.quote?.bid, 2005, "no own quote: the platform quote, attributed to its writer");
  assert.equal(stranger.provenance?.bridgeConnectionId, 22);
});
