// Ruby structural read — machine enums survive the user-copy scrubber.
//
// Owner screenshot 2026-10-27 (V75 1m, Deriv public data, admin with trading
// blocked): the Scanner showed ELEANOR "Full read / Eleanor can give a full,
// live read." and the chart read's Feed/Data "Live read on V75 1m." while the
// SAME read's Risk line said "Exact entry, stop, and target levels withheld —
// Live feed is delayed …". Root cause: the service wrapped the STRUCTURAL_ONLY
// payload in scrubUserCopyDeep, whose SCREAMING_SNAKE rule blanked
// `readLayer: "STRUCTURAL_ONLY"` and `tradeHealthFreshness: "HISTORICAL_ONLY"`
// to "" on the wire, so the client could not see that the setup was withheld.
//
// This drives the REAL buildRubyStructuralRead (only the IO seams are mocked)
// for every layer and asserts the wire agrees with `outcome.readLayer`, the
// trade-health freshness band is intact, and every narrative string is still
// leak-free (the scrubber must keep doing its job).

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency, requiredClosedBarsForTimeframe } from "@workspace/domain/market";
import { findInternalLeaks } from "@workspace/domain/security";

type Ctx = Record<string, unknown> | null;
let nextCtx: Ctx = null;
let nextFeed: { aiUsable: boolean; quality: string } | null = null;

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
    getChartFeedStatus: async () => nextFeed,
  },
});
const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    // No network: the FVG block's multi-TF fetch fails open (block absent).
    routeCandles: async () => {
      throw new Error("network disabled in test");
    },
  },
});

const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");

function candles(n: number): { time: string; open: number; high: number; low: number; close: number }[] {
  const out = [];
  const t0 = Date.UTC(2026, 9, 27, 12, 40);
  let p = 33250;
  for (let i = 0; i < n; i++) {
    const o = p;
    // Gentle up-drift with alternating pullbacks (higher highs / higher lows).
    const c = o + (i % 3 === 2 ? -4 : 6);
    out.push({ time: new Date(t0 + i * 60_000).toISOString(), open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c });
    p = c;
  }
  return out;
}

function ctx(freshnessVerdict: "LIVE" | "LIVE_DELAYED", closed: number, basis = "VERIFIED"): Record<string, unknown> {
  const sufficiency = evaluateMarketDataSufficiency({
    symbol: "V75",
    timeframe: "M1",
    freshnessVerdict,
    availableClosedCandles: closed,
    minimumRequiredCandles: requiredClosedBarsForTimeframe("M1"),
  });
  return {
    symbol: "V75",
    displaySymbol: "V75",
    timeframe: "M1",
    basis,
    confidentReadAllowed: true,
    hasFormingCandle: true,
    closedBarsCount: closed,
    limitedHistory: false,
    liveDelayed: freshnessVerdict === "LIVE_DELAYED",
    sufficiency,
    trustLine: "Verified M1 candles · Live feed",
    blockReason: null,
    aaciChartHandshakeOverall: "PASS",
    gateOutput: { chartTruthScore: 90, chartReadScore: 80, autonomousChartActionAllowed: true },
    state: { stale: false, aiUsable: true },
    candles: candles(closed),
    htfCandles: [],
  };
}

const NARRATIVE_KEYS = ["headline", "trustLine", "blockedReason", "why", "riskNote", "tradeHealthLabel", "tradeHealthTrustLine", "disclaimer"];

function assertNarrativeClean(chartRead: Record<string, unknown>): void {
  for (const k of NARRATIVE_KEYS) {
    const v = chartRead[k];
    if (typeof v === "string") assert.deepEqual(findInternalLeaks(v), [], `${k} leaks: ${v}`);
  }
  for (const c of (chartRead.cautions as string[] | undefined) ?? []) {
    assert.deepEqual(findInternalLeaks(c), [], `caution leaks: ${c}`);
  }
}

test("STRUCTURAL_ONLY (owner state: delayed 1m feed, 199 closed bars) keeps readLayer + freshness on the wire", async () => {
  nextCtx = ctx("LIVE_DELAYED", 199);
  nextFeed = { aiUsable: true, quality: "clean" };
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  assert.equal(outcome.readLayer, "STRUCTURAL_ONLY");
  assert.equal(cr.readLayer, "STRUCTURAL_ONLY", "wire readLayer must equal outcome.readLayer");
  assert.equal(cr.tradeHealthFreshness, "HISTORICAL_ONLY");
  assert.equal(cr.liveSetupWithheld, true);
  assert.equal(cr.canShowLiveTradeSetup, false);
  assert.equal(cr.basis, "VERIFIED");
  assert.equal(cr.timeframe, "M1");
  const cautions = (cr.cautions as string[]).join(" | ");
  assert.match(cautions, /Exact entry, stop, and target levels withheld/);
  // The closed-bar state lags while the server feed status is clean, so the
  // caution names the real limit (closed candles only), never "delayed feed".
  assert.match(cautions, /Read uses closed candles only/);
  assert.doesNotMatch(cautions, /Live feed is delayed/);
  assertNarrativeClean(cr);
});

test("FULL keeps readLayer FULL and tradeHealthFreshness LIVE_CONFIRMED on the wire", async () => {
  nextCtx = ctx("LIVE", 199);
  nextFeed = { aiUsable: true, quality: "clean" };
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  assert.equal(outcome.readLayer, "FULL");
  assert.equal(cr.readLayer, "FULL");
  assert.equal(cr.tradeHealthFreshness, "LIVE_CONFIRMED");
  assertNarrativeClean(cr);
});

test("INSUFFICIENT (thin history) keeps tradeHealthFreshness on the wire", async () => {
  nextCtx = ctx("LIVE", 10);
  nextFeed = { aiUsable: true, quality: "clean" };
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  assert.equal(outcome.readLayer, "INSUFFICIENT");
  assert.equal(cr.readLayer, "INSUFFICIENT");
  assert.equal(cr.tradeHealthFreshness, "AWAITING");
  assert.equal(cr.gated, true);
  assertNarrativeClean(cr);
});

test("INSUFFICIENT (no context) and unsupported timeframe agree with outcome.readLayer", async () => {
  nextCtx = null;
  nextFeed = null;
  const a = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  assert.equal((a.chartRead as Record<string, unknown>).readLayer, a.readLayer);
  assert.equal((a.chartRead as Record<string, unknown>).tradeHealthFreshness, "AWAITING");
  const b = await buildRubyStructuralRead({ symbol: "V75", timeframe: "7q" });
  assert.equal((b.chartRead as Record<string, unknown>).readLayer, b.readLayer);
  assertNarrativeClean(a.chartRead as Record<string, unknown>);
  assertNarrativeClean(b.chartRead as Record<string, unknown>);
});

test("a server-feed-unconfirmed read is STRUCTURAL_ONLY on the wire even with a LIVE sufficiency verdict", async () => {
  nextCtx = ctx("LIVE", 199);
  nextFeed = { aiUsable: false, quality: "delayed" };
  const outcome = await buildRubyStructuralRead({ symbol: "V75", timeframe: "1m" });
  const cr = outcome.chartRead as Record<string, unknown>;
  assert.equal(outcome.readLayer, "STRUCTURAL_ONLY");
  assert.equal(cr.readLayer, "STRUCTURAL_ONLY");
  assert.equal(cr.tradeHealthFreshness, "HISTORICAL_ONLY");
});
