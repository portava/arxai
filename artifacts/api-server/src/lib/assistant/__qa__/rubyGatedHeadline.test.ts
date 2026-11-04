// Truth regression: the INSUFFICIENT chart-read headline must name the real
// reason the read is gated. When chart intelligence is unavailable (context
// build threw) or the market is blocked (not on the approved list), the
// headline must not blame thin candle history or promise a read "once more
// candles load", because loading candles will not fix either cause.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../../data/types.js";

const CLOSE_TIME = "2026-10-27T16:15:00.000Z";

function candles(n: number): Candle[] {
  const out: Candle[] = [];
  const lastOpen = Date.parse(CLOSE_TIME) - 15 * 60_000;
  for (let i = 0; i < n; i++) {
    const open = 1.08 + i * 0.0001;
    out.push({
      time: new Date(lastOpen - (n - 1 - i) * 15 * 60_000).toISOString(),
      open, high: open + 0.0004, low: open - 0.0003, close: open + 0.0001, volume: 0,
    });
  }
  return out;
}

type Mode = "throw" | "blocked" | "thin";
let mode: Mode = "throw";

function fakeCtx() {
  const bars = candles(8);
  const blocked = mode === "blocked";
  return {
    symbol: blocked ? "XYZABC" : "EURUSD",
    displaySymbol: blocked ? "XYZABC" : "EURUSD",
    timeframe: "M15",
    basis: "INSUFFICIENT",
    confidentReadAllowed: false,
    hasFormingCandle: false,
    closedBarsCount: bars.length,
    limitedHistory: true,
    liveDelayed: false,
    sufficiency: blocked
      ? {
          status: "blocked", freshnessVerdict: "LIVE", canShowTradeSetup: false,
          humanReason: "This market isn't on the approved list, so it can't be analyzed.",
          reasonCode: "source_not_ai_usable", mayShowBias: false,
        }
      : {
          status: "insufficient", freshnessVerdict: "LIVE", canShowTradeSetup: false,
          humanReason: "Not enough closed candles yet (8/20) — waiting for more bars before showing a read.",
          reasonCode: "not_enough_bars", mayShowBias: false,
        },
    trustLine: "", blockReason: blocked
      ? "This market isn't on the approved list, so it can't be analyzed."
      : "Not enough closed candles yet (8/20) — waiting for more bars before showing a read.",
    aaciChartHandshakeOverall: "PASS",
    gateOutput: { chartTruthScore: 50, chartReadScore: 40, autonomousChartActionAllowed: false },
    state: {
      stale: false, aiUsable: true, symbol: "EURUSD", timeframe: "M15",
      latestClosedCandle: { closeTime: CLOSE_TIME, openTime: bars[bars.length - 1]!.time },
      truthState: { quality: "clean" },
    },
    candles: bars, htfCandles: [],
  };
}

const rubyCtxModule = await import("../../data/chart/rubyChartContext.js");
mock.module("../../data/chart/rubyChartContext.js", { namedExports: { ...rubyCtxModule,
  buildRubyChartContext: async () => {
    if (mode === "throw") throw new Error("intelligence state failure");
    return fakeCtx();
  },
} });
const chartData = await import("../../data/chart/chartDataService.js");
mock.module("../../data/chart/chartDataService.js", { namedExports: { ...chartData,
  getChartFeedStatus: async () => ({ aiUsable: true, quality: "clean", stale: false, isLive: true }),
} });
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async () => ({ ok: false, candles: [], attempts: [], primaryProvider: null, provenance: null }),
} });

const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");

test("chart intelligence unavailable: headline does not blame thin history", async () => {
  mode = "throw";
  const out = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M15" });
  const read = out.chartRead as Record<string, unknown>;
  assert.equal(read.readLayer, "INSUFFICIENT");
  assert.match(String(read.blockedReason), /Chart intelligence unavailable/);
  assert.doesNotMatch(String(read.headline), /more candles load/);
  assert.doesNotMatch(String(read.headline), /closed candle history/i);
  assert.match(String(read.headline), /couldn't verify the chart data/i);
});

test("blocked market: headline does not promise a read once candles load", async () => {
  mode = "blocked";
  const out = await buildRubyStructuralRead({ symbol: "XYZABC", timeframe: "M15" });
  const read = out.chartRead as Record<string, unknown>;
  assert.equal(read.readLayer, "INSUFFICIENT");
  assert.match(String(read.blockedReason), /approved list/);
  assert.doesNotMatch(String(read.headline), /more candles load/);
  assert.doesNotMatch(String(read.headline), /closed candle history/i);
});

test("genuinely thin history keeps the thin-history headline", async () => {
  mode = "thin";
  const out = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M15" });
  const read = out.chartRead as Record<string, unknown>;
  assert.equal(read.readLayer, "INSUFFICIENT");
  assert.match(String(read.headline), /Not enough closed candle history/);
});
