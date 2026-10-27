// Higher-timeframe read — the chart read only narrates an HTF it actually read.
//
// Owner screenshot 2026-10-27 (V75 1m, Deriv public data): Eleanor's chart read
// said "Higher-timeframe bias is unclear" and "Higher-timeframe bias No clear
// edge; Mixed on 1m." Root cause: higherTimeframeOf() was keyed on "1m"/"15m"/…
// while buildRubyChartContext passes the canonical "M1", so the lookup returned
// null, no HTF candles were ever fetched, and the "No clear edge" sentinel was
// printed as if the higher timeframe had been read.
//
// Pure tests pin the mapping / staleness / narrative; the service tests drive the
// REAL buildRubyStructuralRead (IO seams mocked) and assert the wire carries
// either a directional HTF bias labelled with its timeframe, or null ("not read").

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency, requiredClosedBarsForTimeframe } from "@workspace/domain/market";

type Ctx = Record<string, unknown> | null;
let nextCtx: Ctx = null;

const realCtxModule = await import("../../data/chart/rubyChartContext.js");
mock.module("../../data/chart/rubyChartContext.js", {
  namedExports: {
    ...realCtxModule,
    buildRubyChartContext: async () => {
      if (nextCtx == null) throw new Error("no context");
      return nextCtx;
    },
  },
});
const realChartData = await import("../../data/chart/chartDataService.js");
mock.module("../../data/chart/chartDataService.js", {
  namedExports: {
    ...realChartData,
    getChartFeedStatus: async () => ({ aiUsable: true, quality: "clean" }),
  },
});
const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    routeCandles: async () => {
      throw new Error("network disabled in test");
    },
  },
});

const {
  analyzeChartStructure,
  higherTimeframeOf,
  readHigherTimeframeBias,
} = await import("../chartStructure.js");
const { pivotPriorFromHtf } = await import("../../data/chart/marketIntelligenceService.js");
const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");

type C = { time: string; open: number; high: number; low: number; close: number };

function series(n: number, stepMs: number, endMs: number, drift: number, start = 33250): C[] {
  const out: C[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + (i % 3 === 2 ? -drift * 0.6 : drift);
    out.push({
      time: new Date(endMs - (n - 1 - i) * stepMs).toISOString(),
      open: o,
      high: Math.max(o, c) + 2,
      low: Math.min(o, c) - 2,
      close: c,
    });
    p = c;
  }
  return out;
}

test("higherTimeframeOf maps canonical codes (what buildRubyChartContext passes) and aliases to a canonical HTF", () => {
  assert.equal(higherTimeframeOf("M1"), "M15");
  assert.equal(higherTimeframeOf("1m"), "M15");
  assert.equal(higherTimeframeOf("M5"), "H1");
  assert.equal(higherTimeframeOf("M15"), "H1");
  assert.equal(higherTimeframeOf("M30"), "H4");
  assert.equal(higherTimeframeOf("H1"), "H4");
  assert.equal(higherTimeframeOf("H4"), "D1");
  assert.equal(higherTimeframeOf("D1"), "W1");
  // No higher timeframe ⇒ null; a timeframe is never its own HTF.
  assert.equal(higherTimeframeOf("W1"), null);
  assert.equal(higherTimeframeOf("1w"), null);
  assert.equal(higherTimeframeOf("MN1"), null);
  assert.equal(higherTimeframeOf("7q"), null);
});

test("readHigherTimeframeBias fails closed to null on missing, thin or stale HTF bars", () => {
  const now = Date.UTC(2026, 9, 27, 16, 3);
  const fresh = series(120, 15 * 60_000, now - 60_000, 12);
  assert.equal(readHigherTimeframeBias(fresh, "M15", now), "Bullish");
  assert.equal(readHigherTimeframeBias([], "M15", now), null);
  assert.equal(readHigherTimeframeBias(fresh.slice(-5), "M15", now), null);
  assert.equal(readHigherTimeframeBias(fresh, null, now), null);
  // Newest 15m bar opened 2 hours ago → stale → not presented as the current HTF bias.
  const stale = series(120, 15 * 60_000, now - 2 * 3_600_000, 12);
  assert.equal(readHigherTimeframeBias(stale, "M15", now), null);
});

test("analyzeChartStructure never narrates an HTF it did not read, and names the HTF it did read", () => {
  const now = Date.UTC(2026, 9, 27, 16, 3);
  const ltf = series(200, 60_000, now, 6);
  const notRead = analyzeChartStructure(ltf, { htfBias: null, htfTimeframe: "M15" });
  assert.equal(notRead.htfBias, null);
  assert.equal(notRead.htfTimeframe, "M15");
  assert.doesNotMatch(notRead.why, /Higher-timeframe bias is unclear/);
  assert.doesNotMatch(notRead.why, /Higher.timeframe/i);
  assert.match(notRead.why, /^On this timeframe /);

  const omitted = analyzeChartStructure(ltf);
  assert.equal(omitted.htfBias, null, "no default sentinel when the caller passes nothing");

  const read = analyzeChartStructure(ltf, { htfBias: "Bullish", htfTimeframe: "M15" });
  assert.match(read.why, /^Higher timeframe \(15m\) leans bullish\. /);
  const ranged = analyzeChartStructure(ltf, { htfBias: "Range-bound", htfTimeframe: "H1" });
  assert.match(ranged.why, /^Higher timeframe \(1h\) is range-bound\. /);
});

test("daily pivots come only from a current D1 series — never from the 15m/1h HTF", () => {
  const now = Date.UTC(2026, 9, 27, 16, 3);
  const m15 = series(120, 15 * 60_000, now - 60_000, 12);
  const a = pivotPriorFromHtf(m15, "M15", now);
  assert.equal(a.pivotSourceTimeframe, "session");
  assert.equal(a.prior, null);
  const d1 = series(30, 86_400_000, Date.UTC(2026, 9, 27, 0, 0), 40);
  const b = pivotPriorFromHtf(d1, "D1", now);
  assert.equal(b.pivotSourceTimeframe, "daily");
  assert.ok(b.prior);
  // Newest D1 bar is not today's → the "prior" bar is not yesterday → no daily pivots.
  const d1Stale = series(30, 86_400_000, Date.UTC(2026, 9, 25, 0, 0), 40);
  assert.equal(pivotPriorFromHtf(d1Stale, "D1", now).pivotSourceTimeframe, "session");
});

function ctx(htfCandles: C[], htfTimeframe: string | null): Record<string, unknown> {
  const sufficiency = evaluateMarketDataSufficiency({
    symbol: "V75",
    timeframe: "M1",
    freshnessVerdict: "LIVE_DELAYED",
    availableClosedCandles: 199,
    minimumRequiredCandles: requiredClosedBarsForTimeframe("M1"),
  });
  return {
    symbol: "V75",
    displaySymbol: "V75",
    timeframe: "M1",
    basis: "VERIFIED",
    confidentReadAllowed: true,
    hasFormingCandle: true,
    closedBarsCount: 199,
    limitedHistory: false,
    liveDelayed: true,
    sufficiency,
    trustLine: "Verified M1 candles · Live feed",
    blockReason: null,
    aaciChartHandshakeOverall: "PASS",
    gateOutput: { chartTruthScore: 90, chartReadScore: 80, autonomousChartActionAllowed: true },
    state: { stale: false, aiUsable: true },
    candles: series(199, 60_000, Date.now() - 60_000, 6),
    htfCandles,
    htfTimeframe,
  };
}

test("owner state (V75 1m, no HTF bars obtained): the wire says the 15m HTF was not read", async () => {
  nextCtx = ctx([], "M15");
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  assert.equal(cr.htfBias, null);
  assert.equal(cr.htfTimeframe, "M15");
  assert.doesNotMatch(String(cr.why), /Higher-timeframe bias is unclear/);
  assert.doesNotMatch(String(cr.why), /Higher.timeframe/i);
});

test("V75 1m with 120 trending 15m bars: the wire carries a directional 15m bias, labelled", async () => {
  nextCtx = ctx(series(120, 15 * 60_000, Date.now() - 60_000, 12), "M15");
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  assert.equal(cr.htfBias, "Bullish");
  assert.equal(cr.htfTimeframe, "M15");
  assert.doesNotMatch(String(cr.why), /Higher-timeframe bias is unclear/);
  assert.match(String(cr.why), /Higher timeframe \(15m\) leans bullish/);
});
