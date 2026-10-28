// QA — chart feedStatus describes what is actually serving the chart.
//
// Real chartDataService over a controllable router stand-in (pattern of
// formingTipSourceIsolation.test.ts). Each block pins one board claim:
//   - "Last tick" carries the MT5 broker tick time the server observed.
//   - "Latency" is the winning provider read time; nothing served → unknown.
//   - Source copy never says "your" broker: the chart route has no viewer.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/chart/__qa__/feedStatusTruthLabels.test.ts

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const MIN = 60_000;
const M5 = 5 * MIN;

interface RouteState {
  ok: boolean;
  candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>;
  primaryProvider: string | null;
  attempts: Array<{ provider: string; ok: boolean; reason: string | null; candleCount: number; ms: number }>;
  provenance: Record<string, unknown> | null;
  assetClass: string;
}
const route: RouteState = { ok: true, candles: [], primaryProvider: "mt5_broker", attempts: [], provenance: null, assetClass: "forex" };

function series(n: number, newestOpenMs: number, intervalMs: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = newestOpenMs - (n - 1 - i) * intervalMs;
    return { time: new Date(t).toISOString(), open: 1.1 + i * 1e-4, high: 1.1003 + i * 1e-4, low: 1.0998 + i * 1e-4, close: 1.1001 + i * 1e-4, volume: 100 };
  });
}

mock.module("../../marketDataRouter.js", { namedExports: {
  classifySymbol: () => route.assetClass,
  routeCandles: async (symbol: string) => ({
    ok: route.ok, symbol, assetClass: route.assetClass, candles: route.candles,
    primaryProvider: route.primaryProvider, attempts: route.attempts,
    provenance: route.provenance, userMessage: route.ok ? null : "No feed.",
  }),
} });
mock.module("../sessionProfile.js", { namedExports: { getSessionProfile: async () => null, isSlotExpected: () => true } });

const { foldFormingTick, __resetFormingBarStore } = await import("../formingBarComposer.js");
const { getChartCandles } = await import("../chartDataService.js");

// Tue 2026-10-27 14:02:30 UTC — an ordinary open forex session.
const WEEKDAY_NOW = Date.UTC(2026, 9, 27, 14, 2, 30);

function withNow<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => nowMs;
  return fn().finally(() => { Date.now = real; });
}

function liveMt5(nowMs: number, intervalMs = M5) {
  route.ok = true;
  route.primaryProvider = "mt5_broker";
  route.assetClass = "forex";
  route.candles = series(60, Math.floor(nowMs / intervalMs) * intervalMs - intervalMs, intervalMs);
  route.attempts = [{ provider: "mt5_broker", ok: true, reason: null, candleCount: 60, ms: 1 }];
  route.provenance = { providerId: "mt5_broker", subProviderId: null, brokerCode: "mt5", bridgeConnectionId: 7, userId: 42,
    brokerSymbol: null, environment: "unknown", receivedAt: new Date(nowMs).toISOString(), delayed: false, source: "DERIVED", sourceId: "mt5_broker:EURUSD:M5" };
}

beforeEach(() => __resetFormingBarStore());

test("Last tick: an MT5-served chart reports the broker tick the server received", async () => {
  liveMt5(WEEKDAY_NOW);
  foldFormingTick("EURUSD", 1.1, WEEKDAY_NOW - 1_000, WEEKDAY_NOW - 1_000, "mt5_broker");
  foldFormingTick("EURUSD", 1.1002, WEEKDAY_NOW, WEEKDAY_NOW, "mt5_broker");
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60, true));
  assert.equal(out.feedStatus.source, "mt5_broker");
  assert.equal(out.feedStatus.lastTickTime, new Date(WEEKDAY_NOW).toISOString());
});

test("Last tick: no MT5 tick observed for the symbol stays unknown (never invented)", async () => {
  liveMt5(WEEKDAY_NOW);
  foldFormingTick("GBPUSD", 1.3, WEEKDAY_NOW, WEEKDAY_NOW, "mt5_broker");
  foldFormingTick("EURUSD", 1.1, WEEKDAY_NOW, WEEKDAY_NOW, "deriv_public");
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60, true));
  assert.equal(out.feedStatus.lastTickTime, null);
});

test("Last tick: a replayed frozen quote is not reported as a fresh tick", async () => {
  liveMt5(WEEKDAY_NOW);
  const brokerTime = WEEKDAY_NOW - 30 * MIN;
  for (let i = 5; i >= 0; i--) foldFormingTick("EURUSD", 1.1, brokerTime, WEEKDAY_NOW - i * 10_000, "mt5_broker");
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60, true));
  assert.equal(out.feedStatus.lastTickTime, null);
});

test("Latency: a feed that served nothing has no latency (not the sum of failed probes)", async () => {
  route.ok = false;
  route.primaryProvider = null;
  route.candles = [];
  route.provenance = null;
  route.attempts = [
    { provider: "mt5_broker", ok: false, reason: "MT5_BROKER_FEED_NOT_ACTIVE", candleCount: 0, ms: 700 },
    { provider: "assistant_real", ok: false, reason: "timeout", candleCount: 0, ms: 800 },
  ];
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60, true));
  assert.equal(out.feedStatus.quality, "unavailable");
  assert.equal(out.feedStatus.latencyMs, null);
  assert.equal(out.latencyMs, null);
});

test("Latency: a served feed reports the winning provider's read time only", async () => {
  liveMt5(WEEKDAY_NOW);
  route.attempts = [
    { provider: "mt5_broker", ok: false, reason: "MT5_TIMEFRAME_MISSING", candleCount: 0, ms: 900 },
    { provider: "assistant_real", ok: true, reason: null, candleCount: 60, ms: 120 },
  ];
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60, true));
  assert.equal(out.feedStatus.latencyMs, 120);
});

test("Source copy: an MT5 series is never attributed to the viewer (the route knows no viewer)", async () => {
  // GET /api/chart/candles calls getChartCandles without a user; the unpinned
  // MT5 read serves whichever bridge pushed last (here user 42's bridge 7).
  liveMt5(WEEKDAY_NOW);
  const { chartSeriesAttribution } = await import("../brokerQuoteBinding.js");
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60));
  assert.equal(chartSeriesAttribution(out)?.userId, 42);
  assert.equal(out.feedStatus.quality, "clean");
  assert.doesNotMatch(out.feedStatus.message, /\byour\b/i);
  assert.match(out.feedStatus.message, /MetaTrader 5 broker bridge/);
});
