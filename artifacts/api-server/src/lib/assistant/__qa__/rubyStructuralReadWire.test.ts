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
//   2. The withheld reason names the gate that actually withheld the setup
//      (sufficiency / feed status / chart-truth basis) and never recites the
//      sufficiency "Enough recent closed candles…" success line.
//   3. The owner's case — closed-bar sufficiency says delayed while the
//      forming-tip feed status is clean — says "closed candles only" with the
//      newest closed candle's time, never "Live feed is delayed".
//   4. `observedAt` is the latest CLOSED candle's close time on every layer.
//   5. The narrative strings are still scrubbed (no internal leaks).
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
  "withheldBy", "observedAt",
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

test("owner's case: closed-bar sufficiency delayed + clean forming-tip feed → STRUCTURAL_ONLY reaches the wire and says closed candles, not delayed", async () => {
  reset();
  const outcome = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", clientFeedUnconfirmed: false, userId: null });
  const read = outcome.chartRead;
  assert.equal(outcome.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.readLayer, "STRUCTURAL_ONLY", "readLayer must survive the user-copy scrubber");
  assert.equal(read.liveSetupWithheld, true);
  assert.equal(read.canShowLiveTradeSetup, false);
  assert.equal(read.reasonCode, "stale_feed", "shared reasonCode must survive");
  assert.equal(read.gated, false);
  assert.equal(read.basis, "VERIFIED");
  assert.equal(read.canReadStructure, true);
  assert.equal(read.tradeHealthFreshness, "HISTORICAL_ONLY", "tradeHealthFreshness enum (SCREAMING_SNAKE) must not be blanked");
  assert.equal(read.withheldBy, "sufficiency");
  assert.equal(read.observedAt, CLOSE_TIME, "observedAt is the latest closed candle's close time");
  const cautions = cautionsOf(read);
  const withheld = cautions.find((c) => c.startsWith("Exact entry, stop, and target levels withheld"));
  assert.ok(withheld, "structural read carries the withheld caution");
  assert.doesNotMatch(withheld!, /Live feed is delayed/, "the page's feed status is clean — the read must not call the feed delayed");
  assert.match(withheld!, /closed candles only/i);
  assert.match(withheld!, /16:03 UTC/);
  assert.equal(cautions.filter((c) => /closed candles only/i.test(c)).length, 1, "the closed-candle limitation is stated once");
  assert.equal(read.blockedReason, withheld!.replace("Exact entry, stop, and target levels withheld — ", ""), "blockedReason (the panel's primary reason) matches the caution");
  assert.deepEqual(findInternalLeaks(JSON.stringify(narrativeOnly(read))), [], "narrative strings stay scrubbed");
  assert.ok(typeof read.supportZone === "string" && read.supportZone.length > 0, "structure (S/R) is still read from closed candles");
});

test("sufficiency partial + feed status NOT clean → the delayed reason is true and is kept verbatim", async () => {
  reset();
  feedStatusOverride = { aiUsable: false, quality: "delayed", stale: false };
  const { chartRead: read } = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  assert.equal(read.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.withheldBy, "sufficiency");
  assert.equal(read.blockedReason, PARTIAL_DELAYED.humanReason);
  assert.ok(cautionsOf(read).some((c) => c.endsWith(PARTIAL_DELAYED.humanReason)));
});

test("sufficiency sufficient + server feed status not clean → the caution cites the feed status, never the sufficiency success line", async () => {
  reset();
  ctxOverride = { sufficiency: SUFFICIENT };
  feedStatusOverride = { aiUsable: false, quality: "stale", stale: true };
  const { chartRead: read } = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  assert.equal(read.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.reasonCode, "sufficient");
  assert.equal(read.withheldBy, "feed_status");
  assert.match(String(read.blockedReason), /feed quality/i);
  assert.match(String(read.blockedReason), /stale/);
  for (const c of cautionsOf(read)) assert.doesNotMatch(c, /Enough recent closed candles/);
  assert.doesNotMatch(String(read.blockedReason), /Enough recent closed candles/);
});

test("sufficiency sufficient + client reported the feed unconfirmed → names the client chart as the source", async () => {
  reset();
  ctxOverride = { sufficiency: SUFFICIENT };
  const { chartRead: read } = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", clientFeedUnconfirmed: true, userId: null });
  assert.equal(read.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.withheldBy, "feed_status");
  assert.match(String(read.blockedReason), /chart reported/i);
});

test("sufficiency sufficient + feed probe failed → says the feed status was unavailable (fail-closed, honest)", async () => {
  reset();
  ctxOverride = { sufficiency: SUFFICIENT };
  feedStatusOverride = null;
  const { chartRead: read } = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  assert.equal(read.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.withheldBy, "feed_status");
  assert.match(String(read.blockedReason), /unavailable/i);
});

test("sufficiency sufficient + clean feed + basis PARTIAL → the caution cites the chart-truth gate reason", async () => {
  reset();
  ctxOverride = { sufficiency: SUFFICIENT, basis: "PARTIAL", blockReason: "Broker mirror is degraded — chart truth only partially verified." };
  const { chartRead: read } = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  assert.equal(read.readLayer, "STRUCTURAL_ONLY");
  assert.equal(read.basis, "PARTIAL");
  assert.equal(read.withheldBy, "basis");
  assert.equal(read.blockedReason, "Broker mirror is degraded — chart truth only partially verified.");
  for (const c of cautionsOf(read)) assert.doesNotMatch(c, /Enough recent closed candles/);
});

test("FULL branch keeps reasonCode / freshness enums and carries observedAt", async () => {
  reset();
  ctxOverride = { sufficiency: SUFFICIENT };
  const outcome = await buildRubyStructuralRead({ symbol: "R_75", timeframe: "1m", userId: null });
  const read = outcome.chartRead;
  assert.equal(outcome.readLayer, "FULL");
  assert.equal(read.readLayer, "FULL");
  assert.equal(read.reasonCode, "sufficient");
  assert.equal(read.tradeHealthFreshness, "LIVE_CONFIRMED");
  assert.equal(read.liveSetupWithheld, false);
  assert.equal(read.observedAt, CLOSE_TIME);
  assert.equal(read.withheldBy, null);
  assert.deepEqual(findInternalLeaks(JSON.stringify(narrativeOnly(read))), []);
});

test("INSUFFICIENT branch keeps readLayer / reasonCode and carries observedAt", async () => {
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
  assert.equal(read.observedAt, CLOSE_TIME);
  assert.deepEqual(findInternalLeaks(JSON.stringify(narrativeOnly(read))), []);
});
