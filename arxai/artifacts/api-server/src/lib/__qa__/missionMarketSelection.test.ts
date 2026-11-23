import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { ScannerOpportunity } from "../marketScanner.js";
import type { MarketCandlesResult, MarketQuoteResult } from "../data/marketDataRouter.js";

import { assessRiskObjection, missionTrendConfirmationHolds } from "@workspace/domain/profit-mission";
import { bindScannerSource, scannerSourceIdentity } from "../scannerInputIntegrity.js";

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
let chartUsable = true;
let chartOffset = 0;
let levelOffset: number | undefined;
let attributed = false;
let cachedUser = 7;
function writer() {
  return { providerId: candleSource, subProviderId: null, bridgeConnectionId: 1, brokerSymbol: "V75", userId: 7, environment: "demo" as const };
}
function chartState() {
  return {
    aiUsable: chartUsable, truthState: { source: candleSource }, gateOutput: { scannerConfirmAllowed: chartAllowed },
    latestClosedCandle: { openTime: lastClosedTime, open: last, high: last + 0.5, low: last - 0.5, close: last + chartOffset },
    marketUnderstanding: { levels: { levels: levelOffset === undefined ? [] : [
      { price: last + direction * levelOffset, kind: direction > 0 ? "resistance" : "support", personality: "defended" },
    ] } },
  };
}
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
    return { ok: true, symbol, assetClass: "synthetic", primaryProvider: candleSource, attempts: [], userMessage: "", adminDetail: "", candles,
      ...(attributed ? { provenance: { ...writer(), brokerCode: "deriv", delayed: false, receivedAt: new Date().toISOString(), source: "DERIVED", sourceId: candleSource + ":" + symbol + ":M1" } } : {}) };
  },
  routeQuote: async (symbol: string): Promise<MarketQuoteResult> => ({
    ok: true, symbol, assetClass: "synthetic", primaryProvider: quoteSource, attempts: [], userMessage: "", adminDetail: "",
    quote: { symbol, bid: last + priceOffset - 0.01, ask: last + priceOffset + 0.01, timestamp: new Date().toISOString() },
  }),
} });
mock.module("../data/chart/chartIntelligence.js", { namedExports: {
  buildChartIntelligenceState: async () => chartState(),
  getCachedIntelligenceContext: () => attributed ? { state: chartState(), seriesAttribution: { ...writer(), userId: cachedUser } } : null,
} });
const { scoutPaperMissionMarket } = await import("../missionMarketSelection.js");
beforeEach(() => { direction = 1; priceOffset = 0; historyCalls = 0; unavailable = false; quoteSource = candleSource = "deriv"; chartAllowed = true; chartUsable = true; chartOffset = 0; levelOffset = undefined; attributed = false; cachedUser = 7; });

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
    assert.equal(p.entryPlan.confirmationClose, 1000 + sign * (0.15 * 248 - 0.4));
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
  chartOffset = 0;
  chartUsable = false;
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

test("Mission keeps the reviewed market and trend on the same data feed", async () => {
  const reviewed = { ...row, feedProvider: "deriv" };
  quoteSource = candleSource = "deriv_public";
  const p = await scoutPaperMissionMarket(reviewed, "fallback");
  assert.equal(p.direction, "NONE");
  assert.match(p.reason, /source changed/i);
});

test("Mission rejects a changed account source even when its provider name matches", async () => {
  const priorSource = scannerSourceIdentity({ primaryProvider: candleSource, provenance: {
    sourceId: "deriv:V75:M1", providerId: "deriv", environment: "demo",
  } as NonNullable<MarketCandlesResult["provenance"]> });
  const reviewed = bindScannerSource({ ...row, feedProvider: candleSource }, priorSource);
  const p = await scoutPaperMissionMarket(reviewed, "source-changed");
  assert.equal(p.direction, "NONE");
  assert.match(p.reason, /source changed/i);
  const same = bindScannerSource({ ...row, feedProvider: candleSource }, scannerSourceIdentity({ primaryProvider: candleSource }));
  assert.equal((await scoutPaperMissionMarket(same, "source-matches")).direction, "BUY");
});

test("independent Mission brackets use its own defended price on either side, including for risk review", async () => {
  quoteSource = candleSource = "deriv_public";
  const waiting = { ...row, feedProvider: candleSource, chartConfirmed: false };
  for (const sign of [1, -1]) {
    direction = sign;
    levelOffset = undefined;
    const nominal = await scoutPaperMissionMarket(waiting, "trend");
    levelOffset = 0.3;
    const capped = await scoutPaperMissionMarket(waiting, "trend");
    const price = last + sign * levelOffset;
    assert.equal(capped.direction, nominal.direction);
    assert.equal(capped.marketSnapshot?.strategyTarget, nominal.riskPlan.takeProfit);
    assert.equal(capped.riskPlan.takeProfit, price);
    assert.equal(capped.marketSnapshot?.defendedLevel, price);
    assert.equal(capped.riskPlan.stopLoss, nominal.riskPlan.stopLoss);
    assert.equal(sign > 0 ? capped.entryPlan.entryZoneHigh : capped.entryPlan.entryZoneLow,
      (price + capped.riskPlan.stopLoss!) / 2);
    assert.match(assessRiskObjection(capped)!, /below the 1R floor/);
    assert.match(capped.reason, sign > 0 ? /defended resistance/ : /defended support/);
    levelOffset = 0.01;
    const atLevel = await scoutPaperMissionMarket(waiting, "no-room");
    assert.equal(atLevel.direction, "NONE");
    assert.match(atLevel.reason, /already at defended/);
  }
});

test("a private chart level needs the same series writer and exact bar as the Mission read", async () => {
  attributed = true;
  levelOffset = 0.3;
  const exact = await scoutPaperMissionMarket(row, "same-writer");
  assert.equal(exact.marketSnapshot?.defendedLevel, last + 0.3);
  cachedUser = 8;
  const other = await scoutPaperMissionMarket(row, "different-writer");
  assert.equal(other.marketSnapshot?.defendedLevel, undefined);
  assert.ok(other.riskPlan.takeProfit! > exact.riskPlan.takeProfit!);
  cachedUser = 7;
  chartOffset = 0.2;
  const stale = await scoutPaperMissionMarket(row, "different-bar");
  assert.equal(stale.riskPlan.takeProfit, other.riskPlan.takeProfit);
});

test("the fill quote must hold the close on its liquidation side", () => {
  assert.ok(missionTrendConfirmationHolds("BUY", 100, 100.01, 100.03));
  assert.ok(missionTrendConfirmationHolds("SELL", 100, 99.96, 99.99));
  assert.equal(missionTrendConfirmationHolds("BUY", 100, 100, 100.03), false);
  assert.equal(missionTrendConfirmationHolds("SELL", 100, 99.99, 100.01), false);
  assert.equal(missionTrendConfirmationHolds("SELL", 100, 99.98, 100), false);
  assert.equal(missionTrendConfirmationHolds("BUY", 100, 101, 100.9), false);
  assert.equal(missionTrendConfirmationHolds("BUY", Number.NaN, 101, 101.1), false);
});
