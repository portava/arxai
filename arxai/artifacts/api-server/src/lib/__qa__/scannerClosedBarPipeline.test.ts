import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MIN_SUFFICIENT_CLOSED_BARS } from "@workspace/domain/market";
import type { MarketCandlesResult, MarketQuoteResult } from "../data/marketDataRouter.js";
const realRouter = await import("../data/marketDataRouter.js");
const now = Date.now(), interval = 300_000, currentOpen = Math.floor(now / interval) * interval;
let provider = "mt5_broker", quoteProvider = "mt5_broker", quoteTime = now;
let requested: [string, string][] = [];
let candleSymbol = "EURUSD";
function makeBars(closed: number, forming = false) {
  const result = Array.from({ length: closed }, (_, i) => {
    const base = 1.1 + i * 0.0001;
    return { time: new Date(currentOpen - (closed - i) * interval).toISOString(), open: base, high: base + 0.0002, low: base - 0.0001, close: base + 0.0001, volume: 100 };
  });
  if (forming) result.push({ time: new Date(currentOpen).toISOString(), open: 1.1, high: 1.3, low: 0.8, close: 0.85, volume: 90000 });
  return result;
}
let candles = makeBars(60);
mock.module("../data/marketDataRouter.js", { namedExports: { ...realRouter,
  routeCandles: async (symbol: string, timeframe: string): Promise<MarketCandlesResult> => {
    requested.push([symbol, timeframe]);
    return { ok: true, symbol: candleSymbol, assetClass: "forex", candles, primaryProvider: provider, attempts: [], userMessage: "", adminDetail: "" };
  },
  routeQuote: async (symbol: string): Promise<MarketQuoteResult> => ({ ok: true, symbol, assetClass: "forex", quote: { symbol, bid: 1.106, ask: 1.1061, spread: 0.0001, timestamp: new Date(quoteTime).toISOString() }, primaryProvider: quoteProvider, attempts: [], userMessage: "", adminDetail: "" }),
} });
const { scanSymbolTimeframe, effectiveOpportunityScore } = await import("../marketScanner.js");
const { __resetRegimeStateForTests } = await import("../regime/marketRegimeAuthority.js");
beforeEach(() => { candles = makeBars(60); provider = quoteProvider = "mt5_broker"; quoteTime = now; candleSymbol = "EURUSD"; requested = []; __resetRegimeStateForTests(); });

test("forming-price shocks never change scanner scores, regime or feature snapshot", async () => {
  const closed = await scanSymbolTimeframe("EURUSD", "M5");
  candles = makeBars(60, true);
  const forming = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(closed && forming);
  assert.equal(forming.dataStatus, "live");
  for (const key of ["bias", "opportunity", "confidenceScore", "entrySniperScore", "entry", "stopLoss", "takeProfit", "regime", "featureSnapshot"] as const) assert.deepEqual(forming[key], closed[key], key);
});

test("a forming bar cannot satisfy the closed-bar floor", async () => {
  candles = makeBars(MIN_SUFFICIENT_CLOSED_BARS - 1, true);
  const row = await scanSymbolTimeframe("EURUSD", "M5");
  assert.equal(row?.dataStatus, "no_data");
  assert.equal(row?.tradeable, false);
});

test("canonical aliases route one identity and unsupported timeframes never read a provider", async () => {
  const alias = await scanSymbolTimeframe("EUR/USD", "5m");
  assert.equal(alias?.symbol, "EURUSD"); assert.equal(alias?.timeframe, "M5");
  assert.deepEqual(requested, [["EURUSD", "M5"]]);
  assert.equal(await scanSymbolTimeframe("EURUSD", "garbage"), null);
  assert.equal(requested.length, 1);
});

test("wrong-symbol bars and unknown providers cannot create usable scanner rows", async () => {
  candleSymbol = "GBPUSD";
  const wrong = await scanSymbolTimeframe("EURUSD", "M5");
  assert.equal(wrong?.tradeable, false); assert.equal(wrong?.confidenceScore, 0);
  candleSymbol = "EURUSD"; provider = "mock";
  assert.equal((await scanSymbolTimeframe("EURUSD", "M5"))?.dataStatus, "no_data");
});

test("stale or different-provider quotes cannot create live readiness", async () => {
  quoteTime = now - 60_000;
  const stale = await scanSymbolTimeframe("EURUSD", "M5");
  assert.equal(stale?.tradeable, false); assert.equal(stale?.dataStatus, "stale");
  assert.equal(stale?.sufficiency?.canShowTradeSetup, false);
  quoteTime = now; quoteProvider = "assistant_real:twelve_data";
  const mixed = await scanSymbolTimeframe("EURUSD", "M5");
  assert.equal(mixed?.tradeable, false); assert.equal(mixed?.dataStatus, "stale");
});


test("invalid ranking components cannot sort as an unlimited opportunity", async () => {
  const row = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(row);
  assert.equal(effectiveOpportunityScore({ ...row, opportunity: { ...row.opportunity, score: NaN } }), 0);
  assert.equal(effectiveOpportunityScore({ ...row, agentAdvisory: { adjustedScore: Infinity } as never }), 0);
  assert.equal(effectiveOpportunityScore({ ...row, agentGovernance: { rankingScore: 70 } as never, timingContext: { heatBoost: Infinity } as never }), 0);
});
