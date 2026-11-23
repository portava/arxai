import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { ScannerOpportunity } from "../marketScanner.js";
import type { MarketCandlesResult, MarketQuoteResult } from "../data/marketDataRouter.js";

const minute = 60_000;
const row = { symbol: "V75", timeframe: "M1", dataSource: "LIVE_FEED", selectable: true, tradeable: true,
  chartConfirmed: true, recommendedAction: "WAIT", finalRead: { label: "WAIT_FOR_CONFIRMATION" } } as ScannerOpportunity;
let direction = 1;
let priceOffset = 0;
let unavailable = false;
let quoteSource = "deriv";
let candleSource = "deriv";
let lastClosedTime = "";
let chartAllowed = true;
let chartOffset = 0;
let last = 0;
let historyCalls = 0;
mock.module("../data/marketDataRouter.js", { namedExports: {
  quotePinForSeries: () => ({}),
  routeCandles: async (symbol: string): Promise<MarketCandlesResult> => {
    historyCalls++;
    if (unavailable) throw new Error("Feed disconnected");
    const start = Math.floor(Date.now() / minute) * minute - 250 * minute;
    const candles = Array.from({ length: 250 }, (_, i) => {
      const close = 1000 + direction * (0.15 * i + (i % 2 === 0 ? -0.4 : 0.4));
      last = close;
      lastClosedTime = new Date(start + i * minute).toISOString();
      return { time: new Date(start + i * minute).toISOString(), open: close, high: close + 0.5, low: close - 0.5, close, volume: 0 };
    });
    return { ok: true, symbol, assetClass: "synthetic", primaryProvider: candleSource, attempts: [], userMessage: "", adminDetail: "", candles };
  },
  routeQuote: async (symbol: string): Promise<MarketQuoteResult> => ({
    ok: true, symbol, assetClass: "synthetic", primaryProvider: quoteSource, attempts: [], userMessage: "", adminDetail: "",
    quote: { symbol, bid: last + priceOffset - 0.01, ask: last + priceOffset + 0.01, timestamp: new Date().toISOString() },
  }),
} });
mock.module("../data/chart/chartIntelligence.js", { namedExports: {
  buildChartIntelligenceState: async () => ({
    aiUsable: true, truthState: { source: candleSource }, gateOutput: { scannerConfirmAllowed: chartAllowed },
    latestClosedCandle: { openTime: lastClosedTime, open: last, high: last + 0.5, low: last - 0.5, close: last + chartOffset },
  }),
} });
const { scoutPaperMissionMarket } = await import("../missionMarketSelection.js");
beforeEach(() => { direction = 1; priceOffset = 0; historyCalls = 0; unavailable = false; quoteSource = candleSource = "deriv"; chartAllowed = true; chartOffset = 0; });

test("Mission can buy or sell a trend while Scanner waits, using the executable side", async () => {
  for (const sign of [1, -1]) {
    direction = sign;
    const p = await scoutPaperMissionMarket(row, "p");
    assert.equal(p.status, "proposed");
    assert.equal(p.direction, sign === 1 ? "BUY" : "SELL");
    assert.equal(p.entryPlan.entryPrice, last + sign * 0.01);
    assert.ok(p.riskPlan.expectedR! > 1);
    const limit = (p.riskPlan.takeProfit! + p.riskPlan.stopLoss!) / 2;
    assert.ok(Math.abs((sign === 1 ? p.entryPlan.entryZoneHigh : p.entryPlan.entryZoneLow)! - limit) < 1e-10);
    assert.equal(sign === 1 ? p.entryPlan.entryZoneLow : p.entryPlan.entryZoneHigh, null);
    assert.equal(p.marketSnapshot?.scannerRead, "WAIT_FOR_CONFIRMATION");
  }
});

test("a crossed stop, mismatched feed and risk veto withhold an executable Mission plan", async () => {
  priceOffset = -100;
  assert.equal((await scoutPaperMissionMarket(row, "p")).direction, "NONE");
  priceOffset = 0;
  quoteSource = "mt5_broker";
  assert.equal((await scoutPaperMissionMarket(row, "p")).direction, "NONE");
  const calls = historyCalls;
  const veto = await scoutPaperMissionMarket({ ...row, statusBadge: "REJECTED_BY_RISK" }, "p");
  assert.equal(veto.status, "context_only");
  assert.equal(historyCalls, calls);
});

test("Mission checks its own public chart when Scanner has no direction", async () => {
  quoteSource = candleSource = "deriv_public";
  const waiting = { ...row, feedProvider: "deriv_public", chartConfirmed: false };
  assert.equal((await scoutPaperMissionMarket(waiting, "p")).direction, "BUY");
  chartAllowed = false;
  assert.equal((await scoutPaperMissionMarket(waiting, "p")).direction, "NONE");
  chartAllowed = true;
  chartOffset = 0.1;
  assert.equal((await scoutPaperMissionMarket(waiting, "p")).direction, "NONE");
});

test("a feed error preserves the assessed market with a reason", async () => {
  unavailable = true;
  const p = await scoutPaperMissionMarket(row, "unavailable");
  assert.equal(p.symbol, row.symbol);
  assert.equal(p.status, "context_only");
  assert.equal(p.direction, "NONE");
  assert.match(p.reason, /unavailable/i);
});

test("an executable quote that loses the prior close withholds a trend entry", async () => {
  priceOffset = -1;
  const proposal = await scoutPaperMissionMarket(row, "lost-close");
  assert.equal(proposal.direction, "NONE");
  assert.match(proposal.reason, /holding the prior close/);
});
