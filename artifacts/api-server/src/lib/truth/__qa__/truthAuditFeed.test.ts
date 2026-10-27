// Truth audit 2026-10-27 — feed freshness on mis-stamped (future) bars.
// A broker that stamps bars in its own server time (e.g. UTC+2) read as UTC
// produces bars hours in the future. The trailing-interval gap is then negative;
// such a feed must not be classified clean/live/AI-usable.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { marketFixture, NOW } from "./marketEvidenceFixtures.js";
import { buildFeedStatus } from "../../data/freshness.js";

const TWO_HOURS = 2 * 3_600_000;
let f = marketFixture({ now: NOW + TWO_HOURS });
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async () => f.result, routeQuote: async () => f.quote,
} });
const dbModule = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...dbModule, db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
} } });
const { getChartCandles } = await import("../../data/chart/chartDataService.js");
const { buildSymbolTruthSnapshot } = await import("../symbolTruthSnapshot.js");

const base = { routerOk: true, hasSource: true, candleCount: 200 };

test("buildFeedStatus: a newest bar several intervals in the future is not clean", () => {
  const v = buildFeedStatus({ ...base, trailingIntervals: -8 });
  assert.notEqual(v.quality, "clean"); assert.equal(v.aiUsable, false);
});

test("buildFeedStatus: an unknown (non-finite) gap with candles is not clean", () => {
  for (const gap of [NaN, Infinity, -Infinity, null]) {
    const v = buildFeedStatus({ ...base, trailingIntervals: gap });
    assert.notEqual(v.quality, "clean", String(gap)); assert.equal(v.aiUsable, false, String(gap));
  }
});

test("buildFeedStatus: boundary clock skew of one interval stays clean (no false alarm)", () => {
  for (const gap of [-1, 0, 1]) assert.equal(buildFeedStatus({ ...base, trailingIntervals: gap }).quality, "clean", String(gap));
  assert.equal(buildFeedStatus({ ...base, trailingIntervals: 2 }).quality, "delayed");
  assert.equal(buildFeedStatus({ ...base, trailingIntervals: 3 }).quality, "stale");
});

test("actual chart producer does not report a future-stamped series as live/clean", async () => {
  f = marketFixture({ now: NOW + TWO_HOURS });
  const chart = await getChartCandles("EURUSD", "M15", 80, false);
  assert.ok(chart.candles.length > 0);
  assert.ok((chart.feedStatus.trailingIntervals ?? 0) < -1, `gap ${chart.feedStatus.trailingIntervals}`);
  assert.equal(chart.feedStatus.isLive && chart.feedStatus.quality === "clean", false);
  assert.equal(chart.feedStatus.aiUsable, false);
});

test("actual chart producer: a current series is still live/clean", async () => {
  f = marketFixture();
  const chart = await getChartCandles("EURUSD", "M15", 80, false);
  assert.equal(chart.feedStatus.quality, "clean"); assert.equal(chart.feedStatus.isLive, true);
});

test("Truth snapshot over a future-stamped chart is never LIVE_CONFIRMED", async () => {
  f = marketFixture({ now: NOW + TWO_HOURS });
  const absent = async (): Promise<never> => { throw new Error("offline"); };
  const snap = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: (s, tf, l) => getChartCandles(s, tf, l, false), buildNewsFn: absent,
    evaluateScalpFn: absent, computeTimingFn: absent, buildScannerFn: absent,
  });
  assert.notEqual(snap.data.state, "LIVE_CONFIRMED");
});
