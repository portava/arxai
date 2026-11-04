// One execution price source (audit H4, owner decision 2026-11-04): the Risk
// Governor's quote and the paper venue's fill quote both come from the market
// data router, so a rule sizes on the price the venue fills on. A mock
// provider, a missing feed or a stale quote is no execution price at all.
//
// Only the router's routeQuote is stubbed. No network, no broker, no database rows.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/executionPriceSource.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

let served: Record<string, unknown> = {};
const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: { ...realRouter, routeQuote: async (symbol: string) => ({ symbol, assetClass: "forex", attempts: [], userMessage: "no live feed", adminDetail: "", ...served }) },
});

const { loadQuote, EXECUTION_PRICE_SOURCE, isMockQuoteProvider } = await import("../enforce.js");
const { currentQuote, MAX_EXECUTION_QUOTE_AGE_MS } = await import("../../tradeEngine/marketQuote.js");

function live(bid: number, ask: number, ageMs = 0, provider = "mt5_broker") {
  return { ok: true, quote: { symbol: "EURUSD", bid, ask, spread: ask - bid, timestamp: new Date(Date.now() - ageMs).toISOString() }, primaryProvider: provider };
}

test("the governor and the venue read the same router price and name the source", async () => {
  served = live(1.1, 1.1002);
  const gov = await loadQuote(31, "EURUSD");
  const venue = await currentQuote("EURUSD");
  assert.ok(gov && venue.ok);
  assert.equal(gov.bid, 1.1); assert.equal(gov.ask, 1.1002);
  assert.equal(venue.bid, gov.bid); assert.equal(venue.ask, gov.ask);
  assert.equal(gov.source, `${EXECUTION_PRICE_SOURCE}:mt5_broker`);
  assert.equal(venue.source, gov.source);
});

test("no feed: the governor has no quote and the venue refuses with the router's reason", async () => {
  served = { ok: false, quote: null, primaryProvider: null };
  assert.equal(await loadQuote(31, "EURUSD"), null);
  const venue = await currentQuote("EURUSD");
  assert.equal(venue.ok, false);
  if (!venue.ok) assert.ok(venue.reasons.some((r) => r.includes("no live feed")));
});

test("a mock provider is never an execution price", async () => {
  assert.equal(isMockQuoteProvider("assistant_real:mock"), true);
  assert.equal(isMockQuoteProvider("mt5_broker"), false);
  served = live(1.1, 1.1002, 0, "assistant_real:mock");
  assert.equal(await loadQuote(31, "EURUSD"), null);
  const venue = await currentQuote("EURUSD");
  assert.equal(venue.ok, false);
});

test("a stale router quote is refused by the venue", async () => {
  served = live(1.1, 1.1002, MAX_EXECUTION_QUOTE_AGE_MS + 5_000);
  const venue = await currentQuote("EURUSD");
  assert.equal(venue.ok, false);
  if (!venue.ok) assert.ok(venue.reasons.some((r) => r.startsWith("Stale quote")));
});
