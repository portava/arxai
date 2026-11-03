// Truth: Ruby's briefing must describe a closed market or a stored-history
// series the way the chart does — never as a "delayed" (or "stale") live feed.
//
// Real chartDataService + marketOverview over a controllable router stand-in
// (pattern of feedStatusTruthLabels.test.ts). The chart calls a Saturday
// EURUSD series "Market closed ... since the scheduled weekend close" and a
// durable-mirror series "stored MetaTrader 5 broker candles ... not a live
// feed"; the snapshot carries that reason and the briefing says it.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/assistant/__qa__/rubyBriefingClosedMarket.test.ts

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RubyContext } from "../rubyContext.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const D1 = 24 * HOUR;
const M15 = 15 * MIN;
const H1 = HOUR;

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

const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: {
  ...realRouter,
  classifySymbol: () => route.assetClass,
  routeCandles: async (symbol: string) => ({
    ok: route.ok, symbol, assetClass: route.assetClass, candles: route.candles,
    primaryProvider: route.primaryProvider, attempts: route.attempts,
    provenance: route.provenance, userMessage: route.ok ? null : "No feed.",
  }),
} });
const realSession = await import("../../data/chart/sessionProfile.js");
mock.module("../../data/chart/sessionProfile.js", { namedExports: { ...realSession, getSessionProfile: async () => null, isSlotExpected: () => true } });

const { __resetFormingBarStore } = await import("../../data/chart/formingBarComposer.js");
const { getChartCandles } = await import("../../data/chart/chartDataService.js");
const { getSymbolSnapshot } = await import("../../data/marketOverview.js");
const { composeRubyBriefing, marketFeedFromSnapshot } = await import("../rubyContext.js");

function withNow<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => nowMs;
  return fn().finally(() => { Date.now = real; });
}

function mt5Bars(intervalMs: number, newestOpenMs: number, nowMs: number, subProviderId: string | null = null) {
  route.ok = true;
  route.primaryProvider = "mt5_broker";
  route.assetClass = "forex";
  route.candles = series(200, newestOpenMs, intervalMs);
  route.attempts = [{ provider: "mt5_broker", ok: true, reason: null, candleCount: 200, ms: 1 }];
  route.provenance = { providerId: "mt5_broker", subProviderId, brokerCode: "mt5",
    bridgeConnectionId: subProviderId ? null : 7, userId: subProviderId ? null : 42,
    brokerSymbol: null, environment: "unknown", receivedAt: new Date(nowMs).toISOString(), delayed: false,
    source: "DERIVED", sourceId: "mt5_broker:EURUSD" };
}

function briefingFeedLine(marketFeed: NonNullable<RubyContext["symbol"]>["marketFeed"]): string {
  const ctx = {
    generatedAt: "2026-10-31T12:00:00.000Z",
    page: { key: "/", label: "Cockpit" },
    role: "USER",
    isPrivileged: false,
    timeOfDay: "afternoon",
    serverUtcHour: 12,
    session: null,
    symbol: { symbol: "EURUSD", tradable: "unknown", badge: "", assetClass: "forex", marketFeed },
    bridge: { availability: "UNAVAILABLE", connected: false, message: "" },
    account: { mt5: null, allocation: null, openPositions: 0, openPL: null, snapshotFreshness: null, live: null },
    performance: { hasTrades: false },
    news: { connected: true, items: [], riskLevel: "low" },
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
  } as unknown as RubyContext;
  const lines = composeRubyBriefing(ctx).lines;
  const line = lines.find((l) => l.includes("EURUSD") && !/tradab/i.test(l));
  assert.ok(line, `expected a feed line for EURUSD: ${lines.join(" | ")}`);
  return line!;
}

beforeEach(() => __resetFormingBarStore());

const FRI = Date.UTC(2026, 9, 30); // Fri 2026-10-30 00:00 UTC
const SAT_NOON = FRI + D1 + 12 * HOUR; // Sat 2026-10-31 12:00 UTC

test("Saturday D1: the chart says market closed, and the snapshot carries that reason", async () => {
  mt5Bars(D1, FRI, SAT_NOON);
  const chart = await withNow(SAT_NOON, () => getChartCandles("EURUSD", "D1", 200));
  assert.match(chart.feedStatus.message, /^Market closed for EURUSD/);
  assert.equal(chart.feedStatus.notLiveReason, "market_closed");
  const snap = await withNow(SAT_NOON, () => getSymbolSnapshot("EURUSD", "D1"));
  assert.equal(snap.notLiveReason, "market_closed");
  const line = briefingFeedLine(marketFeedFromSnapshot(snap));
  assert.doesNotMatch(line, /delayed|stale/i);
  assert.equal(line,
    "EURUSD is in its scheduled weekend close — no live data until the market reopens, so its chart is history, not a current read.");
});

test("Saturday on the briefing's default timeframe: closed, not 'stale'", async () => {
  mt5Bars(M15, FRI + 21 * HOUR + 45 * MIN, SAT_NOON);
  const snap = await withNow(SAT_NOON, () => getSymbolSnapshot("EURUSD"));
  assert.equal(snap.notLiveReason, "market_closed");
  assert.doesNotMatch(briefingFeedLine(marketFeedFromSnapshot(snap)), /delayed|stale/i);
});

test("Stored MT5 mirror (no bridge pushing): the briefing says stored history, not a delayed feed", async () => {
  const TUE = Date.UTC(2026, 9, 27, 14, 2, 30);
  mt5Bars(H1, Math.floor(TUE / H1) * H1 - H1, TUE, "durable_mirror");
  const chart = await withNow(TUE, () => getChartCandles("EURUSD", "H1", 200));
  assert.match(chart.feedStatus.message, /^Showing stored MetaTrader 5 broker candles/);
  const snap = await withNow(TUE, () => getSymbolSnapshot("EURUSD", "H1"));
  assert.equal(snap.notLiveReason, "stored_history");
  const line = briefingFeedLine(marketFeedFromSnapshot(snap));
  assert.doesNotMatch(line, /delayed/i);
  assert.equal(line,
    "EURUSD is showing stored broker candles with no bridge pushing it — not a live feed, so I'll read it as history only.");
});

test("A live weekday series has no not-live reason and keeps the live line", async () => {
  const TUE = Date.UTC(2026, 9, 27, 14, 2, 30);
  mt5Bars(M15, Math.floor(TUE / M15) * M15 - M15, TUE);
  const snap = await withNow(TUE, () => getSymbolSnapshot("EURUSD"));
  assert.equal(snap.notLiveReason, null);
  assert.equal(snap.freshness, "REALTIME");
  assert.match(briefingFeedLine(marketFeedFromSnapshot(snap)), /clean right now/);
});
