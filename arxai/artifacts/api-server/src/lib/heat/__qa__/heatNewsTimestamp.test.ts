// Owner screenshot 2026-10-27: the heat list printed "News 2m ago" from the
// market-data provider's provider-wide last-success clock, which ANY quote or
// candle fetch moves. The news time must be the headline fetch behind the
// probe, and only when the headline source is confirmed connected.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readNewsProvider } from "../marketHeatProviderStatus.js";
import {
  _markMarketFetchSuccessForTests,
  _resetMarketProviderForTests,
  _setMarketProviderForTests,
  getMarketStatus,
  type MarketProvider,
} from "../../assistant/marketProvider.js";

function provider(getMarketNews: MarketProvider["getMarketNews"]): MarketProvider {
  return {
    name: "polygon", connected: true,
    features: { quotes: true, candles: true, news: true, snapshots: false, economicCalendar: false },
    getLiveQuote: async () => { throw new Error("unused"); },
    getCandles: async () => { throw new Error("unused"); },
    getMarketNews,
    getEconomicCalendar: async () => ({ connected: false, events: [], provider: "polygon" }),
    getSymbolOverview: async (symbol) => ({ connected: false, symbol, description: null, provider: "polygon" }),
    getTradingSessionContext: async () => ({ connected: false, sessions: [], nowUtc: new Date().toISOString(), provider: "polygon" }),
  };
}
afterEach(() => _resetMarketProviderForTests());

test("a failed headline probe reports no news time even though a quote just succeeded", async () => {
  _setMarketProviderForTests(provider(async () => { throw new Error("news down"); }));
  _markMarketFetchSuccessForTests({ freshness: "REALTIME", source: "polygon" });
  assert.ok(getMarketStatus().lastSuccessfulFetchAt, "precondition: the provider-wide clock is set by a quote");
  const read = await readNewsProvider();
  assert.equal(read.connected, false);
  assert.equal(read.updatedAt, null);
  assert.equal(read.source.updatedAt, null);
});

test("a connected probe never borrows the provider-wide quote clock as its headline time", async () => {
  _setMarketProviderForTests(provider(async () => ({ connected: true, items: [], provider: "polygon" })));
  _markMarketFetchSuccessForTests({ freshness: "REALTIME", source: "polygon" });
  const quoteClock = getMarketStatus().lastSuccessfulFetchAt;
  const read = await readNewsProvider();
  assert.equal(read.connected, true);
  // This injected result was not fetched through the provider cache, so its
  // fetch time is unknown: it is reported as unknown, never as the quote time.
  assert.notEqual(read.updatedAt, quoteClock);
  assert.equal(read.updatedAt, null);
});
