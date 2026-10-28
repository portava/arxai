// QA — chart feedStatus describes what is actually serving the chart.
//
// Real chartDataService over a controllable router stand-in (pattern of
// formingTipSourceIsolation.test.ts). Each block pins one board claim:
//   - "Last tick" carries the MT5 broker tick time the server observed.
//   - "Latency" is the winning provider read time; nothing served → unknown.
//   - Source copy never says "your" broker: the chart route has no viewer.
//   - The durable market_candles mirror is stored data, never a live bridge.
//   - A closed market (scheduled weekend) is not live just because a coarse
//     bar is within one interval of the epoch-aligned current bar.
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

function durableMirrorMt5(nowMs: number, intervalMs: number, newestOpenMs: number) {
  // tryMt5Candles step 2: the in-memory store is empty (restart / EA silent
  // >60s) and market_candles served the bars under MT5_BROKER_MIRROR_SOURCE.
  route.ok = true;
  route.primaryProvider = "mt5_broker";
  route.assetClass = "forex";
  route.candles = series(60, newestOpenMs, intervalMs);
  route.attempts = [{ provider: "mt5_broker", ok: true, reason: null, candleCount: 60, ms: 3 }];
  route.provenance = { providerId: "mt5_broker", subProviderId: "durable_mirror", brokerCode: "mt5", bridgeConnectionId: null, userId: null,
    brokerSymbol: null, environment: "unknown", receivedAt: new Date(nowMs).toISOString(), delayed: null, source: "DERIVED", sourceId: "mt5_broker:EURUSD:H1" };
}

test("Durable mirror: stored broker candles are not a live bridge feed", async () => {
  const H1 = 60 * MIN;
  const currentOpen = Math.floor(WEEKDAY_NOW / H1) * H1;
  durableMirrorMt5(WEEKDAY_NOW, H1, currentOpen - H1);
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "H1", 60));
  const { chartSeriesAttribution } = await import("../brokerQuoteBinding.js");
  assert.equal(chartSeriesAttribution(out)?.subProviderId, "durable_mirror");
  assert.equal(out.feedStatus.trailingIntervals, 1, "precondition: newest stored bar trails by one interval");
  assert.equal(out.feedStatus.isLive, false, "no bridge is pushing this series — not live");
  assert.doesNotMatch(out.feedStatus.message, /^Live feed active/);
  assert.doesNotMatch(out.feedStatus.message, /\byour\b/i);
  assert.match(out.feedStatus.message, /stored/i);
});

test("Durable mirror: the forming-tip display path does not make it live either", async () => {
  const currentOpen = Math.floor(WEEKDAY_NOW / M5) * M5;
  durableMirrorMt5(WEEKDAY_NOW, M5, currentOpen - M5);
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60, true));
  assert.equal(out.feedStatus.isLive, false);
  assert.doesNotMatch(out.feedStatus.message, /^Live feed active/);
});

test("Live bridge push (no sub-channel) still reads live", async () => {
  liveMt5(WEEKDAY_NOW);
  const out = await withNow(WEEKDAY_NOW, () => getChartCandles("EURUSD", "M5", 60));
  assert.equal(out.feedStatus.isLive, true);
  assert.match(out.feedStatus.message, /^Live feed active for EURUSD/);
});

// ── Scheduled weekend closure (forex: Fri ~22:00 UTC → reopen) ──────────────
const HOUR = 60 * MIN;
const H4 = 4 * HOUR;
const D1 = 24 * HOUR;
const FRI = Date.UTC(2026, 9, 30); // Fri 2026-10-30 00:00 UTC

function closedBars(intervalMs: number, newestOpenMs: number, nowMs: number) {
  route.ok = true;
  route.primaryProvider = "mt5_broker";
  route.assetClass = "forex";
  route.candles = series(60, newestOpenMs, intervalMs);
  route.attempts = [{ provider: "mt5_broker", ok: true, reason: null, candleCount: 60, ms: 1 }];
  route.provenance = { providerId: "mt5_broker", subProviderId: null, brokerCode: "mt5", bridgeConnectionId: 7, userId: 42,
    brokerSymbol: null, environment: "unknown", receivedAt: new Date(nowMs).toISOString(), delayed: false, source: "DERIVED", sourceId: "mt5_broker:EURUSD" };
}

test("Closed market: H4 at Sat 02:00 UTC whose newest bar opened Fri 20:00 is not live", async () => {
  const now = FRI + D1 + 2 * HOUR;
  closedBars(H4, FRI + 20 * HOUR, now);
  const out = await withNow(now, () => getChartCandles("EURUSD", "H4", 60, true));
  assert.equal(out.feedStatus.trailingIntervals, 1, "precondition: trailing gap alone reads current");
  assert.equal(out.feedStatus.isLive, false);
  assert.doesNotMatch(out.feedStatus.message, /^Live feed active/);
  assert.match(out.feedStatus.message, /market closed/i);
  assert.match(out.feedStatus.message, /2026-10-30 20:00 UTC/);
});

test("Closed market: D1 at Sat 10:00 UTC whose newest bar opened Fri 00:00 is not live", async () => {
  const now = FRI + D1 + 10 * HOUR;
  closedBars(D1, FRI, now);
  const out = await withNow(now, () => getChartCandles("EURUSD", "D1", 60));
  assert.equal(out.feedStatus.trailingIntervals, 1);
  assert.equal(out.feedStatus.isLive, false);
  assert.match(out.feedStatus.message, /market closed/i);
});

test("Closed market: the EA replaying its frozen Friday quote on Saturday does not count as trading", async () => {
  const now = FRI + D1 + 2 * HOUR;
  closedBars(H4, FRI + 20 * HOUR, now);
  const lastQuote = FRI + 21 * HOUR + 54 * MIN;
  for (let i = 5; i >= 0; i--) foldFormingTick("EURUSD", 1.1, lastQuote, now - i * 10_000, "mt5_broker");
  const out = await withNow(now, () => getChartCandles("EURUSD", "H4", 60, true));
  assert.equal(out.feedStatus.isLive, false);
});

test("Open market: a weekday D1 series one interval behind still reads live", async () => {
  const now = FRI - 3 * D1 + 10 * HOUR; // Tue 10:00 UTC
  closedBars(D1, FRI - 4 * D1, now);
  const out = await withNow(now, () => getChartCandles("EURUSD", "D1", 60));
  assert.equal(out.feedStatus.isLive, true);
});

test("Reopen: bars printed after the Friday close are observed trading, not closed", async () => {
  const now = FRI + 2 * D1 + 22 * HOUR + 30 * MIN; // Sun 22:30 UTC
  closedBars(M5, Math.floor(now / M5) * M5 - M5, now);
  const out = await withNow(now, () => getChartCandles("EURUSD", "M5", 60));
  assert.equal(out.feedStatus.isLive, true);
});

test("Friday after the scheduled close: a quote still moving is trading, not closed", async () => {
  const now = FRI + 22 * HOUR + 20 * MIN;
  closedBars(D1, FRI, now);
  foldFormingTick("EURUSD", 1.1, now - 1_000, now - 1_000, "mt5_broker");
  foldFormingTick("EURUSD", 1.1001, now, now, "mt5_broker");
  const out = await withNow(now, () => getChartCandles("EURUSD", "D1", 60));
  assert.equal(out.feedStatus.isLive, true);
});

test("24/7 synthetic is never treated as weekend-closed", async () => {
  const now = FRI + D1 + 10 * HOUR;
  closedBars(D1, FRI, now);
  route.assetClass = "synthetic";
  route.primaryProvider = "mt5_broker";
  const out = await withNow(now, () => getChartCandles("V75", "D1", 60));
  assert.equal(out.feedStatus.isLive, true);
});
