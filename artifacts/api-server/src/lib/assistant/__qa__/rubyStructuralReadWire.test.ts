// Ruby structural chart read — WIRE contract (levels-withheld-vs-shown cluster).
//
// The Scanner "Eleanor Chart Read" panel (POST /me/assistant/read-chart) renders
// `outcome.chartRead` only. This test drives the REAL buildRubyStructuralRead
// with an offline chart context and locks what reaches the wire:
//
//   1. Machine enums survive. `scrubUserCopyDeep` deletes every SCREAMING_SNAKE
//      token from every string it touches, so a payload built as one scrubbed
//      object shipped `readLayer: ""` (STRUCTURAL_ONLY erased), `reasonCode: ""`
//      and `tradeHealthFreshness: ""`. The panel then rendered a withheld
//      structural read as a full live read ("Live read on V75 1m" beside
//      "Exact entry, stop, and target levels withheld").
//   2. The narrative strings are still scrubbed (no internal leaks).
//
// Run: pnpm --filter @workspace/api-server run test:read-chart-structure-tool

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { findInternalLeaks } from "@workspace/domain/security";
import type { Candle } from "../../data/types.js";

const CLOSE_TIME = "2026-10-27T16:03:00.000Z";
const OPEN_OF_LAST = Date.parse(CLOSE_TIME) - 60_000;

function candles(n = 200): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = 33_500 + i * 1.5 + (i % 3) * 0.4;
    out.push({
      time: new Date(OPEN_OF_LAST - (n - 1 - i) * 60_000).toISOString(),
      open, high: open + 4, low: open - 3, close: open + 1.2, volume: 0,
    });
  }
  return out;
}

type Sufficiency = {
  status: "sufficient" | "partial" | "insufficient" | "blocked";
  freshnessVerdict: "LIVE" | "LIVE_DELAYED" | "AWAITING";
  canShowTradeSetup: boolean;
  humanReason: string;
  reasonCode: string;
  mayShowBias: boolean;
};

const PARTIAL_DELAYED: Sufficiency = {
  status: "partial", freshnessVerdict: "LIVE_DELAYED", canShowTradeSetup: false,
  humanReason: "Live feed is delayed — read uses the last confirmed bars, not the current candle.",
  reasonCode: "stale_feed", mayShowBias: false,
};
const SUFFICIENT: Sufficiency = {
  status: "sufficient", freshnessVerdict: "LIVE", canShowTradeSetup: true,
  humanReason: "Enough recent closed candles on a live feed to support a read.",
  reasonCode: "sufficient", mayShowBias: true,
};
const INSUFFICIENT: Sufficiency = {
  status: "insufficient", freshnessVerdict: "LIVE", canShowTradeSetup: false,
  humanReason: "Not enough closed candles yet (5/20) — waiting for more bars before showing a read.",
  reasonCode: "not_enough_bars", mayShowBias: false,
};

let ctxOverride: Record<string, unknown> = {};
let feedStatusOverride: Record<string, unknown> | null | undefined;

function fakeCtx() {
  const bars = candles();
  return {
    symbol: "R_75", displaySymbol: "V75", timeframe: "M1",
    basis: "VERIFIED", confidentReadAllowed: true, hasFormingCandle: true,
    closedBarsCount: bars.length, limitedHistory: false, liveDelayed: false,
    sufficiency: PARTIAL_DELAYED,
    trustLine: "Verified M1 candles · Live feed", blockReason: null,
    aaciChartHandshakeOverall: "PASS",
    gateOutput: { chartTruthScore: 88, chartReadScore: 80, autonomousChartActionAllowed: true },
    state: {
      stale: false, aiUsable: false, symbol: "R_75", timeframe: "M1",
      latestClosedCandle: { closeTime: CLOSE_TIME, openTime: new Date(OPEN_OF_LAST).toISOString() },
      truthState: { quality: "delayed" },
    },
    candles: bars, htfCandles: [],
    ...ctxOverride,
  };
}

const rubyCtxModule = await import("../../data/chart/rubyChartContext.js");
mock.module("../../data/chart/rubyChartContext.js", { namedExports: { ...rubyCtxModule,
  buildRubyChartContext: async () => fakeCtx(),
} });
const chartData = await import("../../data/chart/chartDataService.js");
mock.module("../../data/chart/chartDataService.js", { namedExports: { ...chartData,
  getChartFeedStatus: async () => {
    if (feedStatusOverride === null) throw new Error("probe failed");
    return feedStatusOverride ?? { aiUsable: true, quality: "clean", stale: false, isLive: true };
  },
} });
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", { namedExports: { ...router,
  routeCandles: async () => ({ ok: false, candles: [], attempts: [], primaryProvider: null, provenance: null }),
} });

const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");

const MACHINE_KEYS = [
  "symbol", "timeframe", "gated", "readLayer", "liveSetupWithheld", "canReadStructure",
  "canShowLiveTradeSetup", "canUseCurrentCandleForEntry", "basis", "reasonCode", "dataQuality",
  "chartTruthScore", "chartReadScore", "hasFormingCandle", "tradeHealthFreshness",
];
function narrativeOnly(read: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(read)) if (!MACHINE_KEYS.includes(k)) out[k] = v;
  return out;
}
function cautionsOf(read: Record<string, unknown>): string[] {
  return Array.isArray(read.cautions) ? (read.cautions as string[]) : [];
}
function reset() { ctxOverride = {}; feedStatusOverride = undefined; }

test("owner's case: a STRUCTURAL_ONLY read reaches the wire as STRUCTURAL_ONLY with its machine enums intact", async () => {
  reset();
  const outcome = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", clientFeedUnconfirmed: false, userId: null });
  const read = outcome.chartRead;
  assert.equal(outcome.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.readLayer, "STRUCTURAL_ONLY", "readLayer must survive the user-copy scrubber");
  assert.equal(read.liveSetupWithheld, true);
  assert.equal(read.canShowLiveTradeSetup, false);
  assert.equal(read.canReadStructure, true);
  assert.equal(read.reasonCode, "stale_feed", "shared reasonCode must survive");
  assert.equal(read.gated, false);
  assert.equal(read.basis, "VERIFIED");
  assert.equal(read.tradeHealthFreshness, "HISTORICAL_ONLY", "tradeHealthFreshness enum (SCREAMING_SNAKE) must not be blanked");
  assert.ok(cautionsOf(read).some((c) => c.startsWith("Exact entry, stop, and target levels withheld")));
  assert.deepEqual(findInternalLeaks(JSON.stringify(narrativeOnly(read))), [], "narrative strings stay scrubbed");
  assert.ok(typeof read.supportZone === "string" && read.supportZone.length > 0, "structure (S/R) is still read from closed candles");
});

test("FULL branch keeps reasonCode / freshness enums", async () => {
  reset();
  ctxOverride = { sufficiency: SUFFICIENT };
  const outcome = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  const read = outcome.chartRead;
  assert.equal(outcome.readLayer, "FULL");
  assert.equal(read.readLayer, "FULL");
  assert.equal(read.reasonCode, "sufficient");
  assert.equal(read.tradeHealthFreshness, "LIVE_CONFIRMED");
  assert.equal(read.liveSetupWithheld, false);
  assert.deepEqual(findInternalLeaks(JSON.stringify(narrativeOnly(read))), []);
});

test("INSUFFICIENT branch keeps readLayer / reasonCode", async () => {
  reset();
  ctxOverride = { sufficiency: INSUFFICIENT, closedBarsCount: 5, candles: candles(5), basis: "INSUFFICIENT", blockReason: INSUFFICIENT.humanReason };
  const outcome = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  const read = outcome.chartRead;
  assert.equal(outcome.readLayer, "INSUFFICIENT");
  assert.equal(read.readLayer, "INSUFFICIENT");
  assert.equal(read.reasonCode, "not_enough_bars");
  assert.equal(read.gated, true);
  assert.equal(read.dataQuality, "insufficient");
  assert.ok(typeof read.tradeHealthFreshness === "string" && read.tradeHealthFreshness.length > 0);
  assert.deepEqual(findInternalLeaks(JSON.stringify(narrativeOnly(read))), []);
});
