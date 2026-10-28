// QA — feedStatus never calls a closed market a "stale feed".
//
// On a weekend an M5 forex series trails the current bar by hundreds of
// intervals, so its quality is "stale". The weekend-closure branch of the
// message only covered clean/delayed quality, so the chart said "Feed for
// EURUSD is stale." and the warning "Feed is stale — newest bar trails the
// current bar by 348 intervals." while the market was simply closed.
//
// Outside the scheduled weekend window there is no reliable session source
// (the per-instrument session hours are static UTC estimates and holidays
// are not known), so a lagging series of an instrument that has session
// closes says what was observed — no new bar since a time — and that the
// market may be closed or the feed delayed. Only a 24/7 instrument can be
// called a stale feed. Quality, staleness and isLive are unchanged: this is
// wording only, never a gate.
//
// Real chartDataService over a controllable router stand-in (pattern of
// feedStatusTruthLabels.test.ts). No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/chart/__qa__/feedStatusClosedMarketWording.test.ts

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const MIN = 60_000;
const M5 = 5 * MIN;
const HOUR = 60 * MIN;
const D1 = 24 * HOUR;

interface RouteState {
  candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>;
  primaryProvider: string;
  assetClass: string;
}
const route: RouteState = { candles: [], primaryProvider: "mt5_broker", assetClass: "forex" };

function series(n: number, newestOpenMs: number, intervalMs: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = newestOpenMs - (n - 1 - i) * intervalMs;
    return { time: new Date(t).toISOString(), open: 1.1 + i * 1e-4, high: 1.1003 + i * 1e-4, low: 1.0998 + i * 1e-4, close: 1.1001 + i * 1e-4, volume: 100 };
  });
}

mock.module("../../marketDataRouter.js", { namedExports: {
  classifySymbol: () => route.assetClass,
  routeCandles: async (symbol: string) => ({
    ok: true, symbol, assetClass: route.assetClass, candles: route.candles,
    primaryProvider: route.primaryProvider,
    attempts: [{ provider: route.primaryProvider, ok: true, reason: null, candleCount: route.candles.length, ms: 1 }],
    provenance: { providerId: route.primaryProvider, subProviderId: null, brokerCode: "mt5", bridgeConnectionId: 7, userId: 42,
      brokerSymbol: null, environment: "unknown", receivedAt: new Date(Date.now()).toISOString(), delayed: false, source: "DERIVED", sourceId: `${route.primaryProvider}:${symbol}` },
    userMessage: null,
  }),
} });
mock.module("../sessionProfile.js", { namedExports: { getSessionProfile: async () => null, isSlotExpected: () => true } });

const { __resetFormingBarStore } = await import("../formingBarComposer.js");
const { getChartCandles } = await import("../chartDataService.js");

function withNow<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => nowMs;
  return fn().finally(() => { Date.now = real; });
}

beforeEach(() => __resetFormingBarStore());

const FRI = Date.UTC(2026, 9, 30); // Fri 2026-10-30 00:00 UTC

test("weekend: a closed forex market is not a stale feed (message and warning)", async () => {
  const now = FRI + D1 + 2 * HOUR; // Sat 02:00 UTC
  route.assetClass = "forex";
  route.primaryProvider = "mt5_broker";
  route.candles = series(60, FRI + 21 * HOUR + 55 * MIN, M5); // last bar Fri 21:55
  const out = await withNow(now, () => getChartCandles("EURUSD", "M5", 60));
  assert.equal(out.feedStatus.quality, "stale", "precondition: hundreds of intervals behind");
  assert.equal(out.feedStatus.isLive, false);
  assert.equal(out.feedStatus.stale, true, "staleness flag (a gate input) is unchanged");
  assert.doesNotMatch(out.feedStatus.message, /stale/i);
  assert.match(out.feedStatus.message, /market closed/i);
  assert.match(out.feedStatus.message, /2026-10-30 21:55 UTC/);
  assert.doesNotMatch(out.feedStatus.warning ?? "", /stale/i);
  assert.match(out.feedStatus.warning ?? "", /market closed/i);
  assert.doesNotMatch(out.warning ?? "", /stale/i, "the top-level response warning matches");
});

test("weekday, instrument with session closes: says what was observed and that the market may be closed or delayed", async () => {
  const now = Date.UTC(2026, 9, 27, 23, 0, 0); // Tue 23:00 UTC — DAX is past its estimated close
  route.assetClass = "index";
  route.primaryProvider = "mt5_broker";
  route.candles = series(60, Date.UTC(2026, 9, 27, 20, 55, 0), M5);
  const out = await withNow(now, () => getChartCandles("GER40", "M5", 60));
  assert.equal(out.feedStatus.quality, "stale");
  assert.equal(out.feedStatus.isLive, false);
  for (const text of [out.feedStatus.message, out.feedStatus.warning ?? ""]) {
    assert.doesNotMatch(text, /\bstale\b/i);
    assert.match(text, /may be closed or (the feed )?delayed/i);
    assert.match(text, /2026-10-27 20:55 UTC/);
  }
});

test("a 24/7 market that stops printing bars is a stale feed and says so", async () => {
  const now = Date.UTC(2026, 9, 31, 12, 0, 0); // Saturday — crypto trades
  route.assetClass = "crypto";
  route.primaryProvider = "mt5_broker";
  route.candles = series(60, now - 2 * HOUR, M5);
  const out = await withNow(now, () => getChartCandles("BTCUSD", "M5", 60));
  assert.equal(out.feedStatus.quality, "stale");
  assert.match(out.feedStatus.message, /stale/i);
  assert.doesNotMatch(out.feedStatus.message, /may be closed/i);
});
