// AACI snapshot — chart-derived freshness and structure facts.
// Run via:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/aaci/__qa__/snapshotChartFreshness.test.ts
//
// The AACI market-feed freshness source must be aged from the feed itself (the
// newest live tick the server received), never from when a cached chart state
// was computed. A state built a second ago over a feed whose candles are hours
// old must not score the market feed as fresh, and a chart state whose feed age
// cannot be established must not pass the feed-fresh hard-gate factor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFreshness, type AaciSharedTruthSnapshot } from "@workspace/domain/aaci";
import { smartChartFromState } from "../snapshotService.js";
import type { ChartIntelligenceState } from "../../data/chart/chartIntelligence.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

interface StateOpts {
  lastTickTime?: string | null;
  lastCandleTime?: string | null;
  latestClosedCloseTime?: string | null;
  stale?: boolean;
  aiUsable?: boolean;
  chartTruthScore?: number;
  confidentReadAllowed?: boolean;
  populated?: boolean;
  structureClarity?: number | null;
}

function chartState(o: StateOpts = {}): ChartIntelligenceState {
  const stale = o.stale ?? false;
  const subMetrics = o.structureClarity === null
    ? []
    : [{ key: "structure_clarity", label: "Structure Clarity", rawScore: o.structureClarity ?? 62, detail: "" }];
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    aiUsable: o.aiUsable ?? true,
    stale,
    // Built "now": the cache entry is fresh whatever the feed shows.
    lastUpdated: iso(NOW),
    truthState: {
      lastTickTime: o.lastTickTime === undefined ? null : o.lastTickTime,
      lastCandleTime: o.lastCandleTime === undefined ? null : o.lastCandleTime,
      stale,
    },
    latestClosedCandle: o.latestClosedCloseTime ? { closeTime: o.latestClosedCloseTime } : null,
    marketUnderstanding: { populated: o.populated ?? true },
    decisionState: { bias: "neutral", actionability: "stand_aside" },
    chartReadScore: { score: 50, subMetrics },
    gateOutput: {
      chartTruthScore: o.chartTruthScore ?? 75,
      confidentReadAllowed: o.confidentReadAllowed ?? false,
    },
  } as unknown as ChartIntelligenceState;
}

function snapshotWith(smartChart: AaciSharedTruthSnapshot["smartChart"]): AaciSharedTruthSnapshot {
  return {
    snapshotId: "t",
    timestamp: iso(NOW),
    user: { userId: "1", role: "user" },
    symbolContext: {},
    account: {},
    bridge: { status: "unknown" },
    positions: { openCount: 0 },
    smartChart,
  };
}

const record = (snap: AaciSharedTruthSnapshot, source: string) =>
  computeFreshness(snap, NOW).records.find((r) => r.source === source)!;

test("market feed is aged from the last tick, not from when the cached chart state was built", () => {
  const sixHoursAgo = NOW - 6 * 3_600_000;
  const state = chartState({
    stale: true,
    lastTickTime: iso(sixHoursAgo),
    lastCandleTime: iso(sixHoursAgo),
    latestClosedCloseTime: iso(sixHoursAgo),
  });
  const snap = snapshotWith(smartChartFromState(state));
  const feed = record(snap, "marketFeed");
  assert.equal(feed.ageMs, 6 * 3_600_000, "market feed age is the last tick's age");
  assert.equal(feed.stale, true);
  assert.equal(computeFreshness(snap, NOW).criticalStale, true);
  const candle = record(snap, "candle");
  assert.equal(candle.ageMs, 6 * 3_600_000, "candle age is the newest closed bar's close age");
});

test("a chart state with no observed tick leaves the market-feed age unknown and fails feed-fresh", () => {
  const snap = snapshotWith(smartChartFromState(chartState({ lastTickTime: null })));
  const feed = record(snap, "marketFeed");
  assert.equal(feed.ageMs, null, "no tick → age could not be established");
  assert.equal(feed.stale, true);
  assert.ok(feed.score <= 25, "an unknown feed age never scores as fresh");
  assert.equal(computeFreshness(snap, NOW).criticalStale, true,
    "a chart was read but its feed age could not be checked — feed-fresh must not pass");
});

test("the chart's own stale verdict marks the market feed stale even when ticks still arrive", () => {
  const snap = snapshotWith(smartChartFromState(chartState({ stale: true, lastTickTime: iso(NOW - 200) })));
  const feed = record(snap, "marketFeed");
  assert.equal(feed.ageMs, 200);
  assert.equal(feed.stale, true);
  assert.ok(feed.score <= 25);
  assert.equal(computeFreshness(snap, NOW).criticalStale, true);
});

test("a fresh tick on a feed the chart calls current scores the market feed fresh", () => {
  const snap = snapshotWith(smartChartFromState(chartState({ lastTickTime: iso(NOW - 300) })));
  const feed = record(snap, "marketFeed");
  assert.equal(feed.ageMs, 300);
  assert.equal(feed.stale, false);
  assert.equal(computeFreshness(snap, NOW).criticalStale, false);
});

test("a forming bar's scheduled future close time is not reported as a candle observation", () => {
  const state = chartState({
    lastTickTime: iso(NOW - 300),
    lastCandleTime: iso(NOW + 10 * 60_000),
    latestClosedCloseTime: null,
  });
  const snap = snapshotWith(smartChartFromState(state));
  assert.equal(record(snap, "candle").ageMs, null);
});

test("no smartChart in the snapshot keeps the market feed unknown and non-critical (unchanged)", () => {
  const snap = snapshotWith(undefined);
  assert.equal(record(snap, "marketFeed").ageMs, null);
  assert.equal(computeFreshness(snap, NOW).criticalStale, false);
});

// ── Market Truth structure factor ───────────────────────────────────────────
// smartChart.structureScore feeds Market Truth (M) as market STRUCTURE. The
// chart's data-quality score (chartTruthScore) is not structure: it must not
// earn structure points for a clean but structureless market.

test("structureScore is the chart's structure-clarity read, not the data-quality Chart Truth score", () => {
  const sc = smartChartFromState(chartState({ chartTruthScore: 75, structureClarity: 28 }));
  assert.equal(sc.structureScore, 28);
  assert.notEqual(sc.structureScore, 75);
});

test("structure is unknown (never a score) when it could not be read from a usable feed", () => {
  assert.equal(smartChartFromState(chartState({ populated: false })).structureScore, undefined,
    "engines not populated → structure not measured");
  assert.equal(smartChartFromState(chartState({ stale: true })).structureScore, undefined,
    "stale feed → structure not current");
  assert.equal(smartChartFromState(chartState({ aiUsable: false })).structureScore, undefined,
    "feed not usable for analysis → structure not current");
  assert.equal(smartChartFromState(chartState({ structureClarity: null })).structureScore, undefined,
    "no structure-clarity metric → unknown");
});
