// A failed news lookup is NOT "no news risk".
//
// When the news intelligence lookup throws, or the economic calendar is
// configured but did not answer, scheduled event risk was never checked. The
// scanner final read, the Opportunity Map and the scalp engine must say so and
// withhold actionable reads, instead of collapsing the failure to riskLevel
// "none" ("Technicals clean and no major news catalyst.", READY_NOW, news LOW).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/__qa__/scannerNewsUnchecked.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { ScannerOpportunity } from "../marketScanner.js";
import type { LateDetection } from "@workspace/domain/signal-intelligence";

type Mode = "throw" | "fetch_error" | "connected_quiet" | "not_configured";
let mode: Mode = "throw";

function pack(calendar: { connected: boolean; provider: string; providerState: string }) {
  return {
    riskLevel: "none", bias: "unclear", timing: "quiet", recommendation: "watch",
    upcomingEvent: null, warningSummary: "No major scheduled news for EURUSD in the current window.",
    dataSources: {
      headlines: { connected: false, provider: "none", count: 0 },
      calendar: { ...calendar, note: "" },
      social: { connected: false, provider: "none", note: "" },
    },
  };
}

mock.module("../news/newsIntelligenceService.js", {
  namedExports: {
    getNewsIntelligence: async () => {
      if (mode === "throw") throw new Error("news offline fixture");
      if (mode === "fetch_error") return pack({ connected: false, provider: "trading_economics", providerState: "fetch_error" });
      if (mode === "not_configured") return pack({ connected: false, provider: "none", providerState: "not_configured" });
      return pack({ connected: true, provider: "trading_economics", providerState: "connected" });
    },
  },
});

const { decorateOpportunitiesWithNewsRisk, computeFinalRead } = await import("../marketScanner.js");
const { toInput } = await import("../signalIntelligence/opportunityMapService.js");
const { categorizeOpportunities } = await import("@workspace/domain/signal-intelligence");
const { oppToScannerInput } = await import("../scalp/scalpService.js");
const { evaluateScalp } = await import("../scalp/scalpEngine.js");
const { evaluateMarketDataSufficiency } = await import("@workspace/domain/market");

function liveRow(symbol = "EURUSD"): ScannerOpportunity {
  return {
    symbol,
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: 72,
    entrySniperScore: 70,
    setupType: "Trend continuation",
    entry: 1.1,
    stopLoss: 1.099,
    takeProfit: 1.102,
    statusBadge: "TRADE_READY",
    dataSource: "LIVE_FEED",
    dataStatus: "live",
    chartConfirmed: true,
    historicalContext: { available: true, winRate: 55, alignsWithScanner: true },
    opportunity: { score: 80, label: "STRONG" },
  } as unknown as ScannerOpportunity;
}

const notLate: LateDetection = {
  isLate: false, doNotChase: false, reason: null, distanceFromEntryPct: 0,
  percentOfMoveComplete: 0, remainingRR: 2, candleExtensionAtr: 0,
} as LateDetection;

async function decorated(m: Mode, symbol = "EURUSD"): Promise<ScannerOpportunity> {
  mode = m;
  const [row] = await decorateOpportunitiesWithNewsRisk([liveRow(symbol)]);
  assert.ok(row);
  return row;
}

for (const m of ["throw", "fetch_error"] as const) {
  test(`${m}: scanner final read does not claim 'no major news catalyst'`, async () => {
    const row = await decorated(m, m === "throw" ? "EURUSD" : "GBPUSD");
    assert.equal(row.newsContext?.eventRiskUnchecked, true);
    const fr = computeFinalRead(row);
    assert.notEqual(fr.label, "TRADE_WATCH");
    assert.equal(fr.confidence, "LOW");
    assert.ok(!fr.reasons.some((r) => /no major news catalyst/i.test(r)), fr.reasons.join(" | "));
    assert.ok(fr.reasons.some((r) => /could not be checked/i.test(r)), fr.reasons.join(" | "));
  });

  test(`${m}: opportunity map row is not READY_NOW`, async () => {
    const row = await decorated(m, m === "throw" ? "USDJPY" : "AUDUSD");
    const withRead = { ...row, finalRead: computeFinalRead(row) } as ScannerOpportunity;
    const input = toInput(withRead, notLate);
    const map = categorizeOpportunities([input]);
    assert.notEqual(map.rows[0]?.category, "READY_NOW");
    assert.match(String(map.rows[0]?.reason), /could not be checked/i);
  });

  test(`${m}: scalp engine does not read the unchecked news as LOW risk`, async () => {
    const row = await decorated(m, m === "throw" ? "USDCAD" : "NZDUSD");
    const scanner = oppToScannerInput(row);
    assert.equal(scanner.newsRiskUnchecked, true);
    const r = evaluateScalp({
      symbol: "EURUSD",
      currentPrice: 1.1,
      spec: {
        hasBrokerTruth: true, tradeMode: "FULL", tradeAllowed: true, visible: true, marketOpen: true,
        digits: 5, point: 0.00001, minLot: 0.01, maxLot: 10, lotStep: 0.01, contractSize: 100000,
        tickSize: 0.00001, tickValue: 1, stopsLevelPoints: 0, spreadPoints: 10, category: "forex",
        displayName: "EURUSD",
      },
      scanner: {
        ...scanner,
        sufficiency: evaluateMarketDataSufficiency({
          symbol: "EURUSD", timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 300,
        }),
      },
      account: { balance: 1000, equity: 1000, freeMargin: 1000, leverage: 100 },
      mode: "ANY",
      riskAmount: 10,
    });
    assert.equal(r.canBuildTrade, false);
    assert.notEqual(r.status, "READY");
    assert.equal(r.newsRiskUnchecked, true);
    assert.match(r.plainEnglishReason, /could not be checked/i);
    assert.doesNotMatch(r.plainEnglishReason, /high-impact news/i);
  });
}

test("control: a connected, quiet calendar still reads as no news risk", async () => {
  const row = await decorated("connected_quiet", "XAUUSD");
  assert.notEqual(row.newsContext?.eventRiskUnchecked, true);
  const fr = computeFinalRead(row);
  assert.equal(fr.label, "TRADE_WATCH");
  assert.ok(!fr.reasons.some((r) => /could not be checked/i.test(r)));
  assert.equal(oppToScannerInput(row).newsRiskUnchecked, undefined);
});

test("control: a calendar that is not configured is not reported as a failed check", async () => {
  const row = await decorated("not_configured", "EURGBP");
  assert.notEqual(row.newsContext?.eventRiskUnchecked, true);
});

test("synthetic instruments are not held back by an unchecked calendar", async () => {
  const row = await decorated("fetch_error", "Volatility 75 Index");
  assert.notEqual(row.newsContext?.eventRiskUnchecked, true);
});
