// Ruby chart read — pattern / trendline rows carry what the detectors saw.
//
// Owner screenshot 2026-10-27 (V75 1m): the chart drew a detected trendline with
// a "Break" marker while Eleanor's chart read said "No specific trendline
// named." The server builds trendlineRead / patternRead over the same closed
// candles but OMITTED the key both when the detector looked and found nothing and
// when the window was too short, so a reader could not tell "none" from "not
// assessed". The payload now always carries an explicit detection outcome when
// the detector ran: detected (with its note), none, or insufficient.
//
// Drives the REAL buildRubyStructuralRead (IO seams mocked).

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency, requiredClosedBarsForTimeframe } from "@workspace/domain/market";

let nextCtx: Record<string, unknown> | null = null;

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

const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");
const { classifyTrendlineDetection } = await import("../../data/chart/trendlineTruthService.js");
const { classifyPatternDetection } = await import("../../data/chart/patternTruthService.js");

type C = { time: string; open: number; high: number; low: number; close: number };

/** Rising zig-zag: clear higher lows a support trendline can connect. */
function trending(n: number): C[] {
  const out: C[] = [];
  const end = Date.now() - 60_000;
  for (let i = 0; i < n; i++) {
    const base = 33250 + i * 2;
    const wave = Math.sin(i / 3) * 12;
    const o = base + wave;
    const c = base + Math.sin((i + 1) / 3) * 12;
    out.push({
      time: new Date(end - (n - 1 - i) * 60_000).toISOString(),
      open: o,
      high: Math.max(o, c) + 1.5,
      low: Math.min(o, c) - 1.5,
      close: c,
    });
  }
  return out;
}

/** Perfectly flat bars: nothing to connect. */
function flat(n: number): C[] {
  const end = Date.now() - 60_000;
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(end - (n - 1 - i) * 60_000).toISOString(),
    open: 33588,
    high: 33588,
    low: 33588,
    close: 33588,
  }));
}

function ctx(freshness: "LIVE" | "LIVE_DELAYED", candles: C[]): Record<string, unknown> {
  const sufficiency = evaluateMarketDataSufficiency({
    symbol: "V75",
    timeframe: "M1",
    freshnessVerdict: freshness,
    availableClosedCandles: candles.length,
    minimumRequiredCandles: requiredClosedBarsForTimeframe("M1"),
  });
  return {
    symbol: "V75",
    displaySymbol: "V75",
    timeframe: "M1",
    basis: "VERIFIED",
    confidentReadAllowed: true,
    hasFormingCandle: true,
    closedBarsCount: candles.length,
    limitedHistory: false,
    liveDelayed: freshness === "LIVE_DELAYED",
    sufficiency,
    trustLine: "Verified M1 candles · Live feed",
    blockReason: null,
    aaciChartHandshakeOverall: "PASS",
    gateOutput: { chartTruthScore: 90, chartReadScore: 80, autonomousChartActionAllowed: true },
    state: { stale: false, aiUsable: true },
    candles,
    htfCandles: [],
    htfTimeframe: "M15",
  };
}

type TL = { trendlineNote: string; trendlineStatus: string; trendlineDetection: string; trendlineContextOnly: boolean };
type PR = { patternNote: string; patternStatus: string; patternDetection: string };

for (const freshness of ["LIVE", "LIVE_DELAYED"] as const) {
  test(`${freshness}: trending closed candles → trendlineRead carries the detector's note`, async () => {
    const candles = trending(199);
    assert.equal(classifyTrendlineDetection({ symbol: "V75", timeframe: "M1", rawCandles: candles }), "detected");
    nextCtx = ctx(freshness, candles);
    const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
    assert.equal(outcome.readLayer, freshness === "LIVE" ? "FULL" : "STRUCTURAL_ONLY");
    const tl = (outcome.chartRead as Record<string, unknown>).trendlineRead as TL | undefined;
    assert.ok(tl, "trendlineRead must be present when the detector ran");
    assert.ok(tl.trendlineNote.length > 0);
    assert.equal(tl.trendlineDetection, "detected");
    assert.match(tl.trendlineNote, /trendline|channel|wedge|triangle/i);
    if (freshness === "LIVE_DELAYED") assert.match(tl.trendlineNote, /context only/i);
    const pr = (outcome.chartRead as Record<string, unknown>).patternRead as PR | undefined;
    assert.ok(pr, "patternRead must be present when the detector ran");
    assert.ok(pr.patternNote.length > 0);
  });
}

test("flat window → explicit 'none' observation, never an omitted key", async () => {
  const candles = flat(199);
  nextCtx = ctx("LIVE_DELAYED", candles);
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  const tl = cr.trendlineRead as TL;
  assert.equal(tl.trendlineDetection, "none");
  assert.equal(tl.trendlineStatus, "none");
  assert.match(tl.trendlineNote, /^No (clear )?trendline/);
  const pr = cr.patternRead as PR;
  assert.equal(pr.patternDetection, "none");
  assert.equal(pr.patternStatus, "none");
  assert.match(pr.patternNote, /^No (clear )?chart pattern/);
});

test("detector classification: too-short window is 'insufficient', unsupported timeframe is null (unavailable)", () => {
  const short = trending(12);
  assert.equal(classifyTrendlineDetection({ symbol: "V75", timeframe: "M1", rawCandles: short }), "insufficient");
  assert.equal(classifyPatternDetection({ symbol: "V75", timeframe: "M1", rawCandles: short }), "insufficient");
  assert.equal(classifyTrendlineDetection({ symbol: "V75", timeframe: "7q", rawCandles: short }), null);
  assert.equal(classifyPatternDetection({ symbol: "V75", timeframe: "7q", rawCandles: short }), null);
});
