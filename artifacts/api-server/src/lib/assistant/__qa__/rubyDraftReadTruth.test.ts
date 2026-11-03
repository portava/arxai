// Ruby draft read — truthful gated copy, position-aware hold/close, unknown
// bias and an as-of time.
// Run via:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/assistant/__qa__/rubyDraftReadTruth.test.ts
//
// Pure: builds a ChartIntelligenceState fixture and calls buildRubyDraftRead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRubyDraftRead } from "../rubyDraftRead.js";
import { buildGatedTrustLine } from "../../data/chart/rubyChartContext.js";
import type { ChartIntelligenceState } from "../../data/chart/chartIntelligence.js";

type SubMetric = { key: string; label: string; rawScore: number | null; evidenceStatus: "measured" | "unavailable"; detail: string };

const MEASURED = (key: string, label: string, rawScore = 100): SubMetric =>
  ({ key, label, rawScore, evidenceStatus: "measured", detail: `${label} measured.` });

function subMetrics(over: Partial<Record<string, SubMetric>> = {}): SubMetric[] {
  const base: Record<string, SubMetric> = {
    ohlc_integrity: MEASURED("ohlc_integrity", "OHLC Integrity"),
    timeframe_accuracy: MEASURED("timeframe_accuracy", "Timeframe Accuracy"),
    feed_freshness: MEASURED("feed_freshness", "Feed Freshness"),
    historical_live_merge: MEASURED("historical_live_merge", "Historical/Live Merge Quality"),
    symbol_mirror_accuracy: MEASURED("symbol_mirror_accuracy", "Symbol Mirror Accuracy"),
    render_accuracy: MEASURED("render_accuracy", "Render Accuracy"),
  };
  return Object.values({ ...base, ...over }) as SubMetric[];
}

interface Opts {
  bias?: "bullish" | "bearish" | "neutral" | "unknown";
  aiUsable?: boolean;
  stale?: boolean;
  truthScore?: number;
  confidentReadAllowed?: boolean;
  subMetrics?: SubMetric[];
  lastUpdated?: string;
}

function state(o: Opts = {}): ChartIntelligenceState {
  const truthScore = o.truthScore ?? 90;
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    aiUsable: o.aiUsable ?? true,
    stale: o.stale ?? false,
    lastUpdated: o.lastUpdated ?? "2026-10-28T11:40:00.000Z",
    currentCandle: null,
    candleStats: { barsAnalyzed: 200 },
    marketUnderstanding: {
      populated: true,
      note: "",
      levels: { levels: [] },
      readiness: { quality: "B", score: 64 },
    },
    decisionState: {
      populated: true,
      bias: o.bias ?? "bullish",
      actionability: "watch",
      vetoed: false,
      decision: null,
    },
    decisionFork: { populated: false, downgrade: false, downgradeReason: null, expectations: [], branches: [] },
    decisionReasoning: { populated: false, note: "", improve: [], weaken: [], invalidate: [], opposite: null },
    agentConsensus: {
      populated: false, headline: "", note: "No consensus.", stance: "neutral",
      conflict: false, protective: false, cautions: [], detail: "", agents: [],
    },
    marketSentences: {},
    brokerAlignment: { aligned: false, tolerance: "unknown", brokerDataAvailable: false, quoteBinding: null },
    chartTruthScore: {
      score: truthScore,
      subMetrics: o.subMetrics ?? subMetrics(),
      primaryConcern: null,
    },
    gateOutput: {
      chartTruthScore: truthScore,
      chartReadScore: 60,
      confidentReadAllowed: o.confidentReadAllowed ?? truthScore >= 75,
      scannerConfirmAllowed: truthScore >= 75,
      selfTradeChartAllowed: o.confidentReadAllowed ?? truthScore >= 75,
      candlestickModeAllowed: true,
      autonomousChartActionAllowed: !(o.stale ?? false),
      tradeConfirmationAllowed: true,
      blockedReasons: [],
      primaryBlockReason: null,
    },
  } as unknown as ChartIntelligenceState;
}

const UNMEASURED_MIRROR = subMetrics({
  symbol_mirror_accuracy: {
    key: "symbol_mirror_accuracy", label: "Symbol Mirror Accuracy", rawScore: null,
    evidenceStatus: "unavailable", detail: "Broker mirror accuracy unmeasured — no usable broker-price comparison.",
  },
});

// ── Item: gated read says what actually blocked it ─────────────────────────

test("a clean feed with an unmeasured broker comparison is not called 'syncing' or 'below threshold'", () => {
  const s = state({ truthScore: 80, subMetrics: UNMEASURED_MIRROR });
  const r = buildRubyDraftRead(s, "analyze");
  assert.equal(r.feedUsable, false, "the read is still gated (no loosening)");
  assert.equal(r.dataQuality, "insufficient");
  assert.equal(r.feedConfirmed, true, "the feed itself passed its freshness/quality check");
  assert.doesNotMatch(r.headline, /syncing/i);
  assert.match(r.headline, /feed is clean/i);
  assert.ok(!r.points.some((p) => /below the confidence threshold/i.test(p)),
    "Chart Truth 80 is not below the threshold");
  assert.ok(r.points.some((p) => /Symbol Mirror Accuracy could not be measured/.test(p)),
    `names the unmeasured check (got ${JSON.stringify(r.points)})`);
  assert.ok(!r.cautions.includes("Feed not confirmed at read-time — limited visibility."),
    "the feed is confirmed clean");
  assert.equal(r.cautions[0], "The feed is clean, but not every chart check passed at read-time — limited visibility.");
});

test("a Chart Truth score really below 75 is named with its value", () => {
  const r = buildRubyDraftRead(state({ truthScore: 62 }), "analyze");
  assert.ok(r.points.some((p) => p === "Chart Truth score is 62, below the 75 needed for a verified read."),
    JSON.stringify(r.points));
});

test("a stale feed still reads 'feed not confirmed'", () => {
  const r = buildRubyDraftRead(state({ stale: true }), "analyze");
  assert.equal(r.feedConfirmed, false);
  assert.equal(r.cautions[0], "Feed not confirmed at read-time — limited visibility.");
});

test("the gated trust line for a clean feed never says the candles or mirror are syncing", () => {
  const partial = buildGatedTrustLine("M5", { available: true, stale: false, aiUsable: true, basis: "PARTIAL" });
  assert.equal(partial, "M5 candles clean · not every chart check passed · read gated");
  const syncing = buildGatedTrustLine("M5", { available: true, stale: false, aiUsable: true, basis: "SYNCING" });
  assert.equal(syncing, "M5 candles clean · Chart Truth below 75 · read gated");
  // Gated by the caller for its own reason (e.g. thin history): no check blamed.
  const other = buildGatedTrustLine("M5", { available: true, stale: false, aiUsable: true, basis: "VERIFIED" });
  assert.equal(other, "M5 candles clean · read gated");
});

// ── Item: "Hold or close?" never assumes the position runs with the chart ───

test("hold-or-close with a SELL against bullish evidence does not say the thesis holds", () => {
  const s = state({ bias: "bullish" });
  const r = buildRubyDraftRead(s, "hold-or-close", { side: "SELL", entry: 1.1, sl: 1.11, tp: 1.09 });
  assert.equal(r.feedUsable, true, "fixture is a usable read");
  assert.doesNotMatch(r.headline, /isn't broken/);
  assert.equal(r.headline, "Evidence is leaning up — against your SELL; the chart no longer supports that side.");
});

test("hold-or-close with a BUY in line with bullish evidence says so, naming the side", () => {
  const r = buildRubyDraftRead(state({ bias: "bullish" }), "hold-or-close", { side: "BUY", entry: 1.1, sl: 1.09, tp: 1.12 });
  assert.equal(r.headline, "Evidence still leaning up — in line with your BUY; the thesis isn't broken yet.");
  assert.ok(r.points.includes("Based on the BUY side sent with this question — your open positions were not checked."));
});

test("hold-or-close with no position side does not assume one and says positions were not checked", () => {
  const r = buildRubyDraftRead(state({ bias: "bearish" }), "hold-or-close");
  assert.doesNotMatch(r.headline, /isn't broken/);
  assert.equal(r.headline,
    "Evidence is leaning down. I don't know your position side: that supports a short and runs against a long.");
  assert.ok(r.points.includes("I did not check your open positions — this restates the chart only."));
});

// ── Item: a gated read's direction is unknown, and every read has an as-of ──

test("a gated read reports the direction as unknown, never a balanced 'neutral' read", () => {
  const r = buildRubyDraftRead(state({ stale: true, bias: "bullish" }), "analyze");
  assert.equal(r.confidenceLabel, "unverifiable");
  assert.equal(r.bias, "unknown");
  const clean = buildRubyDraftRead(state({ truthScore: 80, subMetrics: UNMEASURED_MIRROR }), "analyze");
  assert.equal(clean.bias, "unknown");
});

test("every read carries the time of the chart state it describes", () => {
  const at = "2026-10-28T11:41:07.000Z";
  assert.equal(buildRubyDraftRead(state({ lastUpdated: at }), "analyze").asOf, at);
  assert.equal(buildRubyDraftRead(state({ lastUpdated: at, stale: true }), "why-not-now").asOf, at);
});
