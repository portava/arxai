// ═══════════════════════════════════════════════════════════════════════════
// selectedMarket.test.ts — truth contract for the "Pick a market — Ruby
// explains it" selected-market builder (Task #518).
//
// The bug this locks down: the panel previously analyzed SIMULATOR candles
// (analyzeMarket → marketSimulator) and rendered their entry/stop/target as if
// they were live broker truth — levels in a 1.08 price world while the chart
// printed 1.15. The builder now analyzes ONLY real candles from the canonical
// chart pipeline (getChartCandles), applies the Task #512 stale-level guard,
// and stamps freshness from the DATA timestamp.
//
// These tests inject a fake getChartCandlesFn (the builder's one SOURCE dep),
// so they exercise the real assembly + guard with crafted candle/feed inputs.
// The simulator is never reachable from this envelope; we assert the source is
// always LIVE_FEED and never SIMULATOR.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSelectedMarketSnapshot,
  clearSelectedMarketCache,
} from "../selectedMarket.js";
import type { SelectedMarketDeps } from "../selectedMarket.js";
import type { ChartCandlesResponse, ChartFeedStatus } from "../../data/chart/chartDataService.js";

export {};

type Bar = { open: number; high: number; low: number; close: number };

// A minimal but shape-faithful chart response. The builder reads only
// `candles` (OHLC) and `feedStatus`, so we cast the rest.
function makeChart(bars: Bar[], fs: Partial<ChartFeedStatus> = {}): ChartCandlesResponse {
  const feedStatus: ChartFeedStatus = {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "mt5_broker",
    isLive: true,
    lastTickTime: null,
    lastCandleTime: null,
    latencyMs: 10,
    missingCandleCount: 0,
    duplicateCount: 0,
    outOfOrderCount: 0,
    invalidOhlcCount: 0,
    trailingIntervals: 1,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    feedReadinessState: null,
    message: "",
    completenessReason: null,
    ...fs,
  } as ChartFeedStatus;
  return { candles: bars, feedStatus } as unknown as ChartCandlesResponse;
}

// Build N bars with a constant per-bar range, drifting up (bullish) into the
// given last close. `range` controls how far the derived stop/target sit from
// price — large range → far levels (stale), tiny range → in-range levels.
function bullishBars(n: number, lastClose: number, range: number): Bar[] {
  const firstClose = lastClose - 0.05 * (lastClose / 1.15); // mild upward drift
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = firstClose + ((lastClose - firstClose) * i) / (n - 1);
    bars.push({ open: close, high: close + range / 2, low: close - range / 2, close });
  }
  return bars;
}

const FRESH_FS: Partial<ChartFeedStatus> = {
  source: "mt5_broker",
  quality: "clean",
  isLive: true,
  stale: false,
  lastCandleTime: "2025-06-12T00:00:00.000Z",
};

// Honest-empty economic-events loader. Injecting it keeps these unit tests fully
// deterministic and off the network: the builder never reaches the real
// `economic_events` DB query, which is the one variable round-trip in this path.
const noEvents: SelectedMarketDeps["loadEventsFn"] = async () => ({
  events: [],
  scorerInput: [],
});

// 1) SIMULATOR NEVER REACHED + EMPTY → honest WAITING envelope.
test("empty feed yields an honest WAITING envelope and never the simulator", async () => {
  clearSelectedMarketCache();
  const stub = (async () =>
    makeChart([], { source: null, quality: "empty", isLive: false, lastCandleTime: null })) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  assert.equal(env.dataSource, "LIVE_FEED");
  assert.notEqual(env.dataSource, "SIMULATOR");
  assert.equal(env.dataState, "UNAVAILABLE");
  assert.equal(env.highlights.bias, "WAIT");
  assert.equal(env.highlights.entryZone, null);
  assert.equal(env.highlights.suggestedStop, null);
  assert.equal(env.highlights.suggestedTakeProfit, null);
  assert.equal(env.levelsWithheld, true);
});

// 2) LEVELS FAR FROM PRICE → withheld by the stale-level guard.
test("levels that drifted far from the current price are withheld", async () => {
  clearSelectedMarketCache();
  // Range 0.05 around price ~1.15 → derived stop ≈ 1.075 (>6% away) → stale.
  const bars = bullishBars(60, 1.15, 0.05);
  const stub = (async () => makeChart(bars, FRESH_FS)) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  assert.equal(env.levelsWithheld, true);
  assert.ok(
    typeof env.levelsWithheldReason === "string" && env.levelsWithheldReason.length > 0,
    "withheld envelope must carry the guard's reason",
  );
  assert.equal(env.highlights.entryZone, null);
  assert.equal(env.highlights.suggestedStop, null);
  assert.equal(env.highlights.suggestedTakeProfit, null);
});

// 3) FRESH IN-RANGE LEVELS → pass through unchanged.
test("fresh in-range levels pass through and are not withheld", async () => {
  clearSelectedMarketCache();
  // Tiny range around price ~1.15 → stop/target well inside 2% → not stale.
  const bars = bullishBars(60, 1.15, 0.0005);
  const stub = (async () => makeChart(bars, FRESH_FS)) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  assert.equal(env.levelsWithheld, false);
  assert.notEqual(env.highlights.entryZone, null);
  assert.notEqual(env.highlights.suggestedStop, null);
  assert.notEqual(env.highlights.suggestedTakeProfit, null);
  assert.equal(env.dataState, "LIVE_CONFIRMED");
  assert.equal(env.dataSource, "LIVE_FEED");
});

// 4) DATA-TIME STAMPING: dataAsOf = feed's newest-candle time, NOT build time.
test("dataAsOf is the feed timestamp and is distinct from the build time", async () => {
  clearSelectedMarketCache();
  const FEED_TIME = "2024-01-02T03:04:05.000Z";
  const bars = bullishBars(60, 1.15, 0.0005);
  const stub = (async () =>
    makeChart(bars, { ...FRESH_FS, lastCandleTime: FEED_TIME })) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  assert.equal(env.dataAsOf, FEED_TIME);
  assert.notEqual(env.dataAsOf, env.generatedAt);
  // generatedAt is the wall-clock build time → within seconds of now.
  assert.ok(Date.now() - +new Date(env.generatedAt) < 60_000);
});

// 5) TIMEFRAME ECHO + cache key separation between timeframes.
test("requested timeframe echoes back and the cache key separates timeframes", async () => {
  clearSelectedMarketCache();
  const bars = bullishBars(60, 1.15, 0.0005);
  const calls: Record<string, number> = {};
  const stub = (async (_symbol: string, tf: string) => {
    calls[tf] = (calls[tf] ?? 0) + 1;
    return makeChart(bars, FRESH_FS);
  }) as SelectedMarketDeps["getChartCandlesFn"];

  const m1a = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", timeframe: "M1" },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(m1a.ok, true);
  if (!m1a.ok) return;
  assert.equal(m1a.timeframe, "M1");
  assert.equal(m1a.cacheHit, false);

  // Same symbol + timeframe → served from cache; the SOURCE dep is not re-hit.
  const m1b = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", timeframe: "M1" },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(m1b.ok, true);
  if (!m1b.ok) return;
  assert.equal(m1b.cacheHit, true);
  assert.equal(calls["M1"], 1);

  // Different timeframe → different cache key → recomputed.
  const h1 = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", timeframe: "H1" },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(h1.ok, true);
  if (!h1.ok) return;
  assert.equal(h1.timeframe, "H1");
  assert.equal(h1.cacheHit, false);
  assert.equal(calls["H1"], 1);
});
