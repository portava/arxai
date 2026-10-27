// Truth audit 2026-10-27 — feed freshness on mis-stamped (future) bars.
// A broker that stamps bars in its own server time (e.g. UTC+2) read as UTC
// produces bars hours in the future. The trailing-interval gap is then negative;
// such a feed must not be classified clean/live/AI-usable.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { marketFixture, NOW } from "./marketEvidenceFixtures.js";
import {
  buildFeedStatus, MAX_FUTURE_CLOCK_SKEW_MS, FUTURE_STAMPED_SERIES_NOTE, newestBarLeadMs,
} from "../../data/freshness.js";
import { trailingIntervalGap } from "../../data/chart/candleNormalization.js";
import { timeframeMs, type ChartTimeframe } from "../../data/chart/timeframes.js";
import { TRUTH_EVIDENCE_TICK_SKEW_MS } from "@workspace/domain/truth";

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

test("buildFeedStatus: clock skew within the absolute allowance stays clean (no false alarm)", () => {
  for (const gap of [-1, 0, 1]) {
    for (const lead of [-60_000, 0, MAX_FUTURE_CLOCK_SKEW_MS]) {
      assert.equal(buildFeedStatus({ ...base, trailingIntervals: gap, newestOpenLeadMs: lead }).quality, "clean", `${gap}/${lead}`);
    }
  }
  assert.equal(buildFeedStatus({ ...base, trailingIntervals: 0 }).quality, "clean");
  assert.equal(buildFeedStatus({ ...base, trailingIntervals: 2 }).quality, "delayed");
  assert.equal(buildFeedStatus({ ...base, trailingIntervals: 3 }).quality, "stale");
});

test("buildFeedStatus: a negative gap without the newest bar's lead cannot be confirmed", () => {
  // Without the observed open time, one interval of skew and a mis-stamped
  // series are indistinguishable → fail closed.
  const v = buildFeedStatus({ ...base, trailingIntervals: -1 });
  assert.equal(v.quality, "invalid"); assert.equal(v.aiUsable, false);
});

test("future-stamp allowance is absolute and equals the Truth tick-time allowance", () => {
  assert.equal(MAX_FUTURE_CLOCK_SKEW_MS, TRUTH_EVIDENCE_TICK_SKEW_MS);
  const v = buildFeedStatus({ ...base, trailingIntervals: 0, newestOpenLeadMs: MAX_FUTURE_CLOCK_SKEW_MS + 1 });
  assert.equal(v.quality, "invalid"); assert.equal(v.aiUsable, false);
  for (const lead of [NaN, null]) {
    assert.equal(buildFeedStatus({ ...base, trailingIntervals: 0, newestOpenLeadMs: lead }).quality, "invalid", String(lead));
  }
});

// Review 2026-10-27 finding 1: the allowance was one INTERVAL and the gap is
// rounded, so +2h/+3h on H2/H4/D1 could read clean (Math.round(-1.5) = -1).
const HOUR = 3_600_000;
const BASE_DAY = Date.UTC(2026, 9, 27);
function stampedVerdict(tf: ChartTimeframe, offsetMs: number, now: number) {
  const iv = timeframeMs(tf);
  const openMs = Math.floor(now / iv) * iv + offsetMs; // the current bar, mis-stamped
  const candles = [{ openTime: new Date(openMs).toISOString() }] as Parameters<typeof trailingIntervalGap>[0];
  const trailingIntervals = trailingIntervalGap(candles, tf, now);
  return { openMs, v: buildFeedStatus({ ...base, trailingIntervals, newestOpenLeadMs: newestBarLeadMs(openMs, now) }) };
}

test("H2/H4/D1 bars stamped +2h/+3h ahead of now are never clean (ms bound, not one interval)", () => {
  // Reviewer probe instants: 10:00 UTC (H2 +2h/+3h, H4 +3h read clean before)
  // and 01:00 UTC (D1 +2h/+3h read clean before).
  const cases: Array<[ChartTimeframe, number, number]> = [
    ["H1", 2 * HOUR, BASE_DAY + 10 * HOUR], ["H1", 3 * HOUR, BASE_DAY + 10 * HOUR],
    ["H2", 2 * HOUR, BASE_DAY + 10 * HOUR], ["H2", 3 * HOUR, BASE_DAY + 10 * HOUR],
    ["H4", 3 * HOUR, BASE_DAY + 10 * HOUR], ["H4", 2 * HOUR, BASE_DAY + 8 * HOUR + 30 * 60_000],
    ["D1", 2 * HOUR, BASE_DAY + 1 * HOUR], ["D1", 3 * HOUR, BASE_DAY + 1 * HOUR],
    ["D1", 3 * HOUR, BASE_DAY + 2 * HOUR + 59 * 60_000],
  ];
  for (const [tf, off, now] of cases) {
    const { openMs, v } = stampedVerdict(tf, off, now);
    assert.ok(openMs - now > MAX_FUTURE_CLOCK_SKEW_MS, `${tf} +${off / HOUR}h fixture opens in the future`);
    assert.equal(v.quality, "invalid", `${tf} +${off / HOUR}h @${new Date(now).toISOString()}`);
    assert.equal(v.aiUsable, false);
  }
});

test("normal current bars stay clean on every timeframe, incl. a forming bar whose closeTime is in the future", () => {
  for (const tf of ["M1", "M15", "H1", "H2", "H4", "D1"] as ChartTimeframe[]) {
    for (const now of [BASE_DAY + 10 * HOUR, BASE_DAY + 10 * HOUR + 1, BASE_DAY + 23 * HOUR + 59 * 60_000]) {
      const { openMs, v } = stampedVerdict(tf, 0, now);
      assert.ok(openMs + timeframeMs(tf) > now, "forming bar: scheduled close is after now");
      assert.equal(v.quality, "clean", `${tf} @${new Date(now).toISOString()}`);
    }
    // Broker clock 3 s ahead at a bar boundary: the new bar opens "in the
    // future" by 3 s (gap −1) — inside the absolute allowance.
    const boundary = BASE_DAY;
    const now = boundary - 3_000;
    const candles = [{ openTime: new Date(boundary).toISOString() }] as Parameters<typeof trailingIntervalGap>[0];
    const v = buildFeedStatus({ ...base, trailingIntervals: trailingIntervalGap(candles, tf, now), newestOpenLeadMs: newestBarLeadMs(boundary, now) });
    assert.equal(v.quality, "clean", `${tf} boundary skew`);
  }
});

test("actual chart producer does not report a future-stamped series as live/clean", async () => {
  f = marketFixture({ now: NOW + TWO_HOURS });
  const chart = await getChartCandles("EURUSD", "M15", 80, false);
  assert.ok(chart.candles.length > 0);
  assert.ok((chart.feedStatus.trailingIntervals ?? 0) < -1, `gap ${chart.feedStatus.trailingIntervals}`);
  assert.equal(chart.feedStatus.isLive && chart.feedStatus.quality === "clean", false);
  assert.equal(chart.feedStatus.aiUsable, false);
});

test("actual chart producer: a series the producer observed future-stamped never reads live/clean, even when its newest bar looks current", async () => {
  // A mis-stamped series that stalled: its old bars now look current, but the
  // producer saw them stamped ahead of receipt (sticky router note).
  f = marketFixture();
  f.result.provenanceNotes = [FUTURE_STAMPED_SERIES_NOTE];
  const chart = await getChartCandles("EURUSD", "M15", 80, false);
  assert.ok(chart.candles.length > 0);
  assert.equal(chart.feedStatus.quality, "invalid");
  assert.equal(chart.feedStatus.isLive, false);
  assert.equal(chart.feedStatus.aiUsable, false);
});

test("actual chart producer: a current series with a forming bar is still live/clean", async () => {
  f = marketFixture({ forming: true });
  const chart = await getChartCandles("EURUSD", "M15", 80, false);
  assert.equal(chart.feedStatus.quality, "clean"); assert.equal(chart.feedStatus.isLive, true);
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
