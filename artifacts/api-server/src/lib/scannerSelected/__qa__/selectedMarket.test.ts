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
import { SELECTED_ANALYSIS_WINDOW } from "../selectedMarket.js";
import { analyzeMarketFromCandles } from "../../aiBrain.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export {};

type Bar = { open: number; high: number; low: number; close: number; isComplete?: boolean };

const STEP_MS = 15 * 60_000;
const DEFAULT_LAST_CLOSE = "2025-06-12T00:00:00.000Z";

// A shape-faithful chart response. Candles carry the NormalizedChartCandle time
// bounds and completion flags the builder reads: every bar is a CLOSED provider
// bar unless it says `isComplete: false` (a forming bar). Closed bars end at
// feedStatus.lastCandleTime (or a fixed default); a forming bar opens there.
function makeChart(bars: Bar[], fs: Partial<ChartFeedStatus> = {}): ChartCandlesResponse {
  const lastClosedCloseMs = Date.parse(fs.lastCandleTime ?? DEFAULT_LAST_CLOSE);
  const closedCount = bars.filter((b) => b.isComplete !== false).length;
  let closedIdx = 0;
  const candles = bars.map((b) => {
    const forming = b.isComplete === false;
    const closeMs = forming
      ? lastClosedCloseMs + STEP_MS
      : lastClosedCloseMs - (closedCount - 1 - closedIdx++) * STEP_MS;
    return {
      ...b,
      openTime: new Date(closeMs - STEP_MS).toISOString(),
      closeTime: new Date(closeMs).toISOString(),
      volume: 0,
      tickVolume: null,
      isComplete: !forming,
      isFinal: !forming,
      isForming: false,
    };
  });
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
  return { candles, feedStatus } as unknown as ChartCandlesResponse;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function freshChart(timestamp = "2026-10-26T12:00:00.000Z") {
  return makeChart(bullishBars(60, 1.15, 0.0005), { ...FRESH_FS, lastCandleTime: timestamp });
}

test("16 concurrent readers share one pending source and news read", async () => {
  clearSelectedMarketCache();
  const gate = deferred<ChartCandlesResponse>();
  let sourceCalls = 0, newsCalls = 0;
  const deps = {
    getChartCandlesFn: async () => { sourceCalls++; return gate.promise; },
    loadEventsFn: async () => { newsCalls++; return noEvents("EURUSD", []); },
  };
  const reads = Array.from({ length: 16 }, () => getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 7 }, deps));
  assert.equal(sourceCalls, 1);
  gate.resolve(freshChart());
  const answers = await Promise.all(reads);
  assert.equal(newsCalls, 1);
  assert.ok(answers.every((answer) => answer.ok && answer.dataAsOf === "2026-10-26T12:00:00.000Z"));
  const cached = await getSelectedMarketSnapshot({ symbolRaw: "eurusd", viewerUserId: 7 }, deps);
  assert.ok(cached.ok && cached.cacheHit);
  assert.equal(cached.symbolRaw, "eurusd");
});

test("pending work never expires into duplicate builds after the cache TTL", async (t) => {
  clearSelectedMarketCache();
  let now = 100_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const gate = deferred<ChartCandlesResponse>();
  const deps = { getChartCandlesFn: async () => { calls++; return gate.promise; }, loadEventsFn: noEvents };
  const first = getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 7 }, deps);
  now += 31_000;
  const second = getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 7 }, deps);
  assert.equal(calls, 1);
  gate.resolve(freshChart());
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
});

test("forced refresh supersedes ordinary work; older completion cannot replace it", async () => {
  clearSelectedMarketCache();
  const old = deferred<ChartCandlesResponse>(), fresh = deferred<ChartCandlesResponse>();
  let calls = 0;
  const deps = { getChartCandlesFn: async () => ++calls === 1 ? old.promise : fresh.promise, loadEventsFn: noEvents };
  const args = { symbolRaw: "EURUSD", viewerUserId: 7 };
  const first = getSelectedMarketSnapshot(args, deps);
  const force = getSelectedMarketSnapshot({ ...args, refresh: true }, deps);
  const joinedForce = getSelectedMarketSnapshot({ ...args, refresh: true }, deps);
  const joinedOrdinary = getSelectedMarketSnapshot(args, deps);
  assert.equal(calls, 2);
  fresh.resolve(freshChart("2026-10-26T12:15:00.000Z"));
  const expected = await force;
  assert.deepEqual(await joinedForce, expected);
  assert.deepEqual(await joinedOrdinary, expected);
  old.resolve(freshChart());
  await first;
  const cached = await getSelectedMarketSnapshot(args, deps);
  assert.ok(cached.ok && cached.dataAsOf === "2026-10-26T12:15:00.000Z" && cached.cacheHit);
});

test("a failed forced build cannot revive an older pending result and permits retry", async () => {
  clearSelectedMarketCache();
  const old = deferred<ChartCandlesResponse>(), failure = deferred<ChartCandlesResponse>();
  let calls = 0;
  const deps = { getChartCandlesFn: async () => { calls++; return calls === 1 ? old.promise : calls === 2 ? failure.promise : freshChart(); }, loadEventsFn: noEvents };
  const args = { symbolRaw: "EURUSD", viewerUserId: 7 };
  const first = getSelectedMarketSnapshot(args, deps);
  const force = getSelectedMarketSnapshot({ ...args, refresh: true }, deps);
  const rejected = assert.rejects(force, /fixture failure/);
  failure.reject(new Error("fixture failure"));
  await rejected;
  old.resolve(freshChart());
  await first;
  const retry = await getSelectedMarketSnapshot(args, deps);
  assert.ok(retry.ok && !retry.cacheHit);
  assert.equal(calls, 3);
});

test("cache and pending work are isolated by viewer, symbol and timeframe", async () => {
  clearSelectedMarketCache();
  let calls = 0;
  const deps = { getChartCandlesFn: async () => { calls++; return freshChart(); }, loadEventsFn: noEvents };
  const reads = [
    { symbolRaw: "EURUSD", viewerUserId: 7, timeframe: "M5" },
    { symbolRaw: "EURUSD", viewerUserId: 8, timeframe: "M5" },
    { symbolRaw: "GBPUSD", viewerUserId: 7, timeframe: "M5" },
    { symbolRaw: "EURUSD", viewerUserId: 7, timeframe: "M15" },
    { symbolRaw: "EURUSD", timeframe: "M5" },
  ];
  await Promise.all(reads.map((args) => getSelectedMarketSnapshot(args, deps)));
  assert.equal(calls, 5);
  await Promise.all(reads.map((args) => getSelectedMarketSnapshot(args, deps)));
  assert.equal(calls, 5);
  await assert.rejects(getSelectedMarketSnapshot({ symbolRaw: "EURUSD", viewerUserId: 0 }, deps), /viewer identity/);
});

test("cached reads preserve source and generated timestamps and expire after the existing 30 seconds", async (t) => {
  clearSelectedMarketCache();
  let now = 100_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const deps = { getChartCandlesFn: async () => { calls++; return freshChart(); }, loadEventsFn: noEvents };
  const args = { symbolRaw: "EURUSD", viewerUserId: 7 };
  const first = await getSelectedMarketSnapshot(args, deps);
  now += 29_000;
  const cached = await getSelectedMarketSnapshot(args, deps);
  assert.ok(first.ok && cached.ok && cached.cacheHit);
  if (first.ok && cached.ok) {
    assert.equal(cached.dataAsOf, first.dataAsOf);
    assert.equal(cached.generatedAt, first.generatedAt);
  }
  now += 2_000;
  await getSelectedMarketSnapshot(args, deps);
  assert.equal(calls, 2);
});

test("clearing the cache fences pending work from repopulating it", async () => {
  clearSelectedMarketCache();
  const gate = deferred<ChartCandlesResponse>();
  let calls = 0;
  const deps = { getChartCandlesFn: async () => ++calls === 1 ? gate.promise : freshChart(), loadEventsFn: noEvents };
  const first = getSelectedMarketSnapshot({ symbolRaw: "EURUSD" }, deps);
  clearSelectedMarketCache();
  gate.resolve(freshChart());
  await first;
  await getSelectedMarketSnapshot({ symbolRaw: "EURUSD" }, deps);
  assert.equal(calls, 2);
});

test("controlled latency probe: one 75ms source read serves 32 readers; warm reads require no I/O", async (t) => {
  clearSelectedMarketCache();
  let sourceCalls = 0, newsCalls = 0;
  const deps = {
    getChartCandlesFn: async () => { sourceCalls++; await new Promise((resolve) => setTimeout(resolve, 75)); return freshChart(); },
    loadEventsFn: async () => { newsCalls++; return noEvents("EURUSD", []); },
  };
  const args = { symbolRaw: "EURUSD", viewerUserId: 7 };
  const started = performance.now();
  await Promise.all(Array.from({ length: 32 }, () => getSelectedMarketSnapshot(args, deps)));
  const coldBatchMs = performance.now() - started;
  const warmMs: number[] = [];
  for (let i = 0; i < 500; i++) {
    const before = performance.now();
    await getSelectedMarketSnapshot(args, deps);
    warmMs.push(performance.now() - before);
  }
  warmMs.sort((a, b) => a - b);
  assert.equal(sourceCalls, 1); assert.equal(newsCalls, 1);
  t.diagnostic(JSON.stringify({ kind: "offline-controlled-latency-not-production-SLA", syntheticSourceDelayMs: 75, concurrentReaders: 32, sourceCalls, newsCalls, coldBatchMs, warmReads: 500, warmP50Ms: warmMs[250], warmP95Ms: warmMs[475] }));
});

// ── Closed-bar window parity with the scanner row ─────────────────────────────
// The scanner row (analyzeViaRouter) reads the newest 30 CLOSED bars; forming
// bars are dropped by prepareScannerCandles. The selected-market panel used all
// 200 chart bars including the forming one, so it could say BUY / bullish while
// the Results card said SELL / bearish for the same symbol and timeframe.
function risingThenFallingWithFormingTip(formingClose: number, formingRange: number): Bar[] {
  const bars: Bar[] = [];
  // 170 older bars drift up 1.10 → 1.15; the newest 30 closed bars drift down.
  for (let i = 0; i < 170; i++) {
    const close = 1.10 + (0.05 * i) / 169;
    bars.push({ open: close, high: close + 0.00025, low: close - 0.00025, close });
  }
  for (let i = 0; i < 30; i++) {
    const close = 1.15 - (0.005 * (i + 1)) / 30;
    bars.push({ open: close, high: close + 0.00025, low: close - 0.00025, close });
  }
  bars.push({
    open: formingClose, high: formingClose + formingRange / 2, low: formingClose - formingRange / 2,
    close: formingClose, isComplete: false,
  });
  return bars;
}

test("the selected-market read uses the scanner's closed 30-bar window, never the forming bar", async () => {
  const run = async (bars: Bar[]) => {
    clearSelectedMarketCache();
    const stub = (async () => makeChart(bars, FRESH_FS)) as SelectedMarketDeps["getChartCandlesFn"];
    const env = await getSelectedMarketSnapshot(
      { symbolRaw: "EURUSD", timeframe: "M15", refresh: true },
      { getChartCandlesFn: stub, loadEventsFn: noEvents },
    );
    assert.equal(env.ok, true);
    if (!env.ok) throw new Error("expected an ok envelope");
    return env;
  };
  const bars = risingThenFallingWithFormingTip(1.1451, 0.0004);
  const env = await run(bars);
  // What the scanner computes for the same series: newest 30 closed bars.
  const scannerWindow = bars.filter((b) => b.isComplete !== false).slice(-30)
    .map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close }));
  const scannerRead = analyzeMarketFromCandles(
    "EURUSD", "M15", scannerWindow, { mid: scannerWindow[scannerWindow.length - 1]!.c, spread: 0 }, "LIVE_FEED",
  );
  assert.equal(scannerRead.marketBias, "bearish");
  assert.equal(env.highlights.trendState, scannerRead.marketBias,
    "the panel must describe the same closed window the scanner row describes");

  // Changing ONLY the forming bar's OHLC (a wide, partial range) leaves the read alone.
  const moved = await run(risingThenFallingWithFormingTip(1.1453, 0.004));
  assert.equal(moved.highlights.trendState, env.highlights.trendState);
  assert.equal(moved.highlights.bias, env.highlights.bias);
  assert.equal(moved.highlights.confidenceScore, env.highlights.confidenceScore);
  assert.equal(moved.highlights.volatilityLabel, env.highlights.volatilityLabel);
  assert.deepEqual(moved.highlights.entryZone, env.highlights.entryZone);
  assert.equal(moved.highlights.suggestedStop, env.highlights.suggestedStop);
});

test("drift guard: the selected-market window equals the scanner's SCAN_ANALYSIS_WINDOW", () => {
  const src = readFileSync(fileURLToPath(new URL("../../marketScanner.ts", import.meta.url)), "utf8");
  const m = /const SCAN_ANALYSIS_WINDOW = (\d+);/.exec(src);
  assert.ok(m, "marketScanner.ts must still declare SCAN_ANALYSIS_WINDOW");
  assert.equal(Number(m[1]), SELECTED_ANALYSIS_WINDOW);
});

// ── dataAsOf is an observation time, never a forming bar's scheduled close ────
// chartDataService sets feedStatus.lastCandleTime to the newest provider bar's
// closeTime. On H4 with a forming bar opened 1h ago that is now + 3h; the panel
// then said "Data as of 0s ago" (timeAgo clamps negative ages to zero).
test("dataAsOf is the newest CLOSED bar's close time and never later than now", async () => {
  clearSelectedMarketCache();
  const now = Date.now();
  const H4 = 4 * 3600_000;
  const formingOpenMs = now - 3600_000;
  const formingCloseMs = formingOpenMs + H4;
  const bars: Bar[] = [...bullishBars(60, 1.15, 0.0005), { open: 1.15, high: 1.1502, low: 1.1498, close: 1.15, isComplete: false }];
  const chart = makeChart(bars, { ...FRESH_FS, lastCandleTime: new Date(formingOpenMs).toISOString() });
  // What chartDataService reports for this series: the forming bar's scheduled close.
  chart.feedStatus = { ...chart.feedStatus!, lastCandleTime: new Date(formingCloseMs).toISOString() };
  const stub = (async () => chart) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", timeframe: "H4", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  assert.ok(env.dataAsOf !== null, "a closed bar exists, so the data time is known");
  assert.ok(Date.parse(env.dataAsOf) <= Date.now(), `dataAsOf ${env.dataAsOf} must not be in the future`);
  assert.equal(env.dataAsOf, new Date(formingOpenMs).toISOString());
});

// ── A stale or syncing feed never shows a directional read ──────────────────
// Repro: EURUSD H1 on a stale mt5_broker feed, newest bar 6h old, window drifting
// up. The price equals the last close, so the level guard does not fire. The
// envelope said dataState STALE but bias BUY, High confidence, trend bullish,
// an entry zone, stop and target, and "This looks like a possible buy setup".
for (const [label, fs] of [
  ["STALE", { source: "mt5_broker", stale: true, quality: "stale", isLive: false, trailingIntervals: 6 }],
  ["SYNCING", { source: "mt5_broker", stale: false, quality: "delayed", isLive: false, trailingIntervals: 2 }],
] as const) {
  test(`a ${label} feed withholds bias, confidence, trend and levels`, async () => {
    clearSelectedMarketCache();
    const lastCandleTime = new Date(Date.now() - 6 * 3600_000).toISOString();
    const stub = (async () => makeChart(bullishBars(200, 1.1033, 0.0002), {
      ...(fs as Partial<ChartFeedStatus>), lastCandleTime,
    })) as SelectedMarketDeps["getChartCandlesFn"];
    const env = await getSelectedMarketSnapshot(
      { symbolRaw: "EURUSD", timeframe: "H1", refresh: true },
      { getChartCandlesFn: stub, loadEventsFn: noEvents },
    );
    assert.equal(env.ok, true);
    if (!env.ok) return;
    assert.equal(env.dataState, label);
    assert.ok(env.highlights.bias === "WAIT" || env.highlights.bias === "NEUTRAL", `bias ${env.highlights.bias}`);
    assert.notEqual(env.highlights.confidenceLabel, "High");
    assert.equal(env.highlights.confidenceScore, 0);
    assert.notEqual(env.highlights.trendState, "bullish");
    assert.equal(env.highlights.entryZone, null);
    assert.equal(env.highlights.suggestedStop, null);
    assert.equal(env.highlights.suggestedTakeProfit, null);
    assert.equal(env.levelsWithheld, true);
    assert.ok(typeof env.readWithheldReason === "string" && env.readWithheldReason.length > 0);
    assert.equal(env.levelsWithheldReason, env.readWithheldReason);
    const copy = [env.explanation.hedge, env.explanation.why, env.explanation.risk, env.explanation.invalidation].join(" ");
    assert.doesNotMatch(copy, /\b(buy|sell|bullish|bearish)\b/i, copy);
  });
}

test("a LIVE_CONFIRMED feed with enough closed bars still shows its read", async () => {
  clearSelectedMarketCache();
  const stub = (async () => makeChart(bullishBars(60, 1.15, 0.0005), FRESH_FS)) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.ok(env.ok);
  if (!env.ok) return;
  assert.equal(env.readWithheldReason, null);
  assert.equal(env.highlights.trendState, "bullish");
});

test("too few closed bars withholds the read with the shared sufficiency reason", async () => {
  clearSelectedMarketCache();
  const stub = (async () => makeChart(bullishBars(3, 1.15, 0.0005), FRESH_FS)) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.ok(env.ok);
  if (!env.ok) return;
  assert.match(env.readWithheldReason ?? "", /Not enough closed candles yet \(3\/5\)/);
  assert.equal(env.highlights.bias, "WAIT");
  assert.equal(env.highlights.entryZone, null);
});

// Finding: the source label must not claim liveness. Already fixed upstream
// (sourceLabelFor names the provider only); locked here for stale data.
test("a stale mt5_broker feed's source label makes no liveness claim", async () => {
  clearSelectedMarketCache();
  const stub = (async () => makeChart(bullishBars(60, 1.15, 0.0005), {
    source: "mt5_broker", stale: true, quality: "stale", isLive: false,
    lastCandleTime: new Date(Date.now() - 4 * 60_000).toISOString(),
  })) as SelectedMarketDeps["getChartCandlesFn"];
  const env = await getSelectedMarketSnapshot(
    { symbolRaw: "EURUSD", timeframe: "M1", refresh: true },
    { getChartCandlesFn: stub, loadEventsFn: noEvents },
  );
  assert.ok(env.ok);
  if (!env.ok) return;
  assert.equal(env.dataState, "STALE");
  assert.doesNotMatch(env.dataSourceLabel ?? "", /live/i);
});
