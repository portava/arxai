// Truth regression: the candle truth engine's STALE reason was a fixed
// "Feed is stale — newest bar trails the current bar by N intervals
// (threshold: 3)", shown as the Chart Truth Score timeframe detail
// ("Assessment STALE — Feed is stale — …"). For a forex/metals/index/stock
// series inside its scheduled weekend close (no bar since the close) that is
// a closed market, and for a session market outside that window the market
// may be closed (daily break, holiday) or the feed delayed — the chart feed
// status already words both cases that way. Only a 24/7 market's lag is
// plainly a stale feed. The assessment itself (STALE) is unchanged. The
// truth score's feed-freshness detail ("Feed stale — lagging by 3+
// intervals.") likewise now states the feed status's own lag wording.
//
// Pure, offline: no provider, DB or broker calls.
// Run: node --import tsx --test --test-force-exit src/lib/data/chart/__qa__/candleTruthStaleReason.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandleTruth } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { noBrokerAlignment } from "../brokerPriceAlignment.js";
import type { ChartFeedStatus } from "../chartDataService.js";
import type { AssetClass } from "../../marketDataRouter.js";

const M5 = 300_000;
function truthAt(symbol: string, assetClass: AssetClass, newestOpenMs: number, now: number, tradingObserved?: boolean) {
  const candles = Array.from({ length: 200 }, (_, i) => ({
    time: new Date(newestOpenMs - (199 - i) * M5).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1,
  }));
  return runCandleTruth(candles, { symbol, displaySymbol: symbol, timeframe: "M5", source: "mt5_broker",
    assetClass, limit: 200, now, ...(tradingObserved === undefined ? {} : { tradingObserved }) }).truthResult;
}

const SAT_NOON = Date.UTC(2026, 9, 31, 12, 0);
const FRI_2155 = Date.UTC(2026, 9, 30, 21, 55);

test("a forex series in its scheduled weekend close is STALE, but the reason says the market is closed", () => {
  const truth = truthAt("EURUSD", "forex", FRI_2155, SAT_NOON, false);
  assert.equal(truth.assessment, "STALE");
  const reason = truth.assessmentReasons[0] ?? "";
  assert.doesNotMatch(reason, /Feed is stale/);
  assert.match(reason, /scheduled weekend close/);
  assert.match(reason, /trails the current bar by \d+ intervals/);
});

test("the Chart Truth timeframe detail carries the closed-market reason, not 'Feed is stale'", () => {
  const truth = truthAt("EURUSD", "forex", FRI_2155, SAT_NOON, false);
  const feed = { symbol: "EURUSD", displaySymbol: "EURUSD", assetClass: "forex", source: "mt5_broker", isLive: false,
    lastTickTime: null, lastCandleTime: new Date(FRI_2155 + M5).toISOString(), latencyMs: null,
    missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 170,
    stale: true, quality: "stale", aiUsable: false, feedReadinessState: null, message: "",
    warning: "Market closed for EURUSD since the scheduled weekend close (2026-10-30 22:00 UTC); newest bar opened 2026-10-30 21:55 UTC. Not a feed fault, and not live data.",
    completenessReason: null } as unknown as ChartFeedStatus;
  const score = computeChartTruthScore(truth, feed, noBrokerAlignment(null, "UNKNOWN"));
  const details = score.subMetrics.map((m) => m.detail ?? "").join(" | ");
  assert.doesNotMatch(details, /Feed is stale|Feed stale/);
  assert.match(details, /Assessment STALE — Market in its scheduled weekend close/);
  assert.match(details, /Market closed for EURUSD since the scheduled weekend close/);
});

test("a session market outside the weekend close may be closed or delayed — never just 'Feed is stale'", () => {
  const wedNoon = Date.UTC(2026, 9, 28, 12, 0);
  const truth = truthAt("EURUSD", "forex", wedNoon - 60 * 60_000, wedNoon);
  assert.equal(truth.assessment, "STALE");
  const reason = truth.assessmentReasons[0] ?? "";
  assert.doesNotMatch(reason, /Feed is stale/);
  assert.match(reason, /may be closed or the feed delayed/);
});

test("a 24/7 market's lag is a stale feed", () => {
  const truth = truthAt("BTCUSD", "crypto", FRI_2155, SAT_NOON);
  assert.equal(truth.assessment, "STALE");
  assert.match(truth.assessmentReasons[0] ?? "", /^Feed is stale — newest bar trails the current bar by \d+ intervals/);
});

// The static weekend window runs past the real reopen (FOREX_SESSION ends
// Monday 00:00 UTC; forex reopens Sunday ~21:00-22:00 UTC; STOCK_US_SESSION
// ends Monday 13:00 UTC while index CFDs trade from Sunday night). The chart
// feed status only calls the market closed when no tick has moved in the last
// two minutes; the truth engine said "scheduled weekend close … no new bars
// are expected" from the schedule alone, so a real bar-feed fault on an open
// market read as an expected closure and contradicted the feed status.
const SUN_2230 = Date.UTC(2026, 10, 1, 22, 30);

test("ticks moving on Sunday night: a missing bar is not called a scheduled weekend close", () => {
  const truth = truthAt("EURUSD", "forex", FRI_2155, SUN_2230, true);
  assert.equal(truth.assessment, "STALE", "the assessment is unchanged");
  const reason = truth.assessmentReasons[0] ?? "";
  assert.doesNotMatch(reason, /scheduled weekend close|no new bars are expected/, reason);
  assert.match(reason, /may be closed or the feed delayed/);
});

test("index CFD trading Monday morning inside the static stock window is not called closed", () => {
  // US30 uses the US-equity session: closes Fri 20:00 UTC, "reopens" Mon 13:00.
  const fri1955 = Date.UTC(2026, 9, 30, 19, 55);
  const monNine = Date.UTC(2026, 10, 2, 9, 0);
  assert.match(truthAt("US30", "indices", fri1955, monNine, false).assessmentReasons[0] ?? "", /scheduled weekend close/,
    "control: with no trading observed the schedule is stated");
  const truth = truthAt("US30", "indices", fri1955, monNine, true);
  assert.doesNotMatch(truth.assessmentReasons[0] ?? "", /scheduled weekend close/);
});

test("without trading evidence from the caller the reason stays hedged", () => {
  const truth = truthAt("EURUSD", "forex", FRI_2155, SAT_NOON);
  const reason = truth.assessmentReasons[0] ?? "";
  assert.doesNotMatch(reason, /scheduled weekend close/, reason);
  assert.match(reason, /may be closed or the feed delayed/);
});
