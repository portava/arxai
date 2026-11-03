// Chart levels, sentences and Ruby's level line print at the instrument's
// precision (truth upgrade, 2026-10-28).
//
// Level prices were rounded server-side by a magnitude rule (>= 1000 → 1 dp,
// >= 1 → 4 dp): XAUUSD support 2400.55 became 2400.6 and EURUSD 1.08523 became
// 1.0852, which the dashboard then padded back out ("2400.60", "1.08520") — a
// precision the server had rounded away. The sentence engine printed with its
// own magnitude rule (V10 3-dp prices at 2 dp, XAGUSD 4-dp at 3 dp), and Ruby
// printed the raw number and the raw personality token ("retest_pending").
// Offline: no provider, DB or broker calls.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveChartPriceDecimals } from "@workspace/domain/chart-patterns";
import { computeLevelPersonality } from "../engines/levelPersonality.js";
import type { NormalizedChartCandle } from "../candleNormalization.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";
import { buildMarketSentences, chartLevelPersonalityWords } from "../marketSentenceEngine.js";
import { activeLevelLine } from "../../../assistant/rubyDraftRead.js";

const epoch = Date.parse("2026-10-20T00:00:00Z");

/** A clean zig-zag between `lo` and `hi`: every trough's low is exactly `lo` and
 *  every peak's high exactly `hi`, so swing levels cluster on those prices. */
function zigzag(symbol: string, lo: number, hi: number, bars = 80): NormalizedChartCandle[] {
  const out: NormalizedChartCandle[] = [];
  const range = hi - lo;
  const w = range / 20;
  for (let i = 0; i < bars; i++) {
    const phase = i % 10;
    let high: number;
    let low: number;
    if (phase === 0) {
      low = lo; high = lo + 2 * w;
    } else if (phase === 5) {
      high = hi; low = hi - 2 * w;
    } else {
      const mid = lo + range * (phase < 5 ? phase / 5 : (10 - phase) / 5);
      high = mid + w; low = mid - w;
    }
    const rising = phase < 5;
    out.push({
      symbol, displaySymbol: symbol, timeframe: "M5",
      openTime: new Date(epoch + i * 300_000).toISOString(),
      closeTime: new Date(epoch + (i + 1) * 300_000).toISOString(),
      open: rising ? low : high, high, low, close: rising ? high : low, volume: null, isComplete: true,
    } as unknown as NormalizedChartCandle);
  }
  return out;
}

function decimalsIn(n: number): number {
  for (let d = 0; d <= 8; d++) if (Math.abs(n - Number(n.toFixed(d))) < 1e-9) return d;
  return 8;
}

test("shared rule: declared precision widened by observed digits; magnitude only when neither is known", () => {
  assert.equal(resolveChartPriceDecimals(2, [2400.55, 2410.5], 2400.55), 2);
  assert.equal(resolveChartPriceDecimals(5, [1.08523], 1.08523), 5);
  assert.equal(resolveChartPriceDecimals(3, [6123.4571], 6123.4571), 4, "observed digits widen (cap +2)");
  assert.equal(resolveChartPriceDecimals(2, [1.123456789], 1.12), 4, "observed widening capped at declared + 2");
  assert.equal(resolveChartPriceDecimals(null, [33588.0069], 33588.0069), 4, "observed alone");
  assert.equal(resolveChartPriceDecimals(null, [], 2400.55), 1, "legacy magnitude fallback");
});

test("XAUUSD levels keep 2 decimals (2400.55, not 2400.6)", () => {
  const read = computeLevelPersonality(zigzag("XAUUSD", 2400.55, 2410.55), [], "XAUUSD", "M5").read;
  assert.equal(read.populated, true);
  assert.ok(read.levels.length > 0);
  assert.ok(read.levels.some((l) => l.price === 2400.55), `levels: ${read.levels.map((l) => l.price).join(", ")}`);
  for (const l of read.levels) assert.ok(decimalsIn(l.price) <= 2, `level ${l.price} has <= 2 dp`);
});

test("EURUSD levels keep 5 decimals (1.08523, not 1.0852)", () => {
  const read = computeLevelPersonality(zigzag("EURUSD", 1.08523, 1.08773), [], "EURUSD", "M5").read;
  assert.ok(read.levels.some((l) => l.price === 1.08523), `levels: ${read.levels.map((l) => l.price).join(", ")}`);
});

function sentenceState(symbol: string, assetClass: string, support: number, close: number): ChartIntelligenceState {
  const level = { kind: "support", price: support, personality: "retest_pending", touchCount: 3, rejectionCount: 1,
    breakCount: 0, retestCount: 1, strengthScore: 70, weaknessScore: 20, trapScore: 0, distancePct: -0.1 };
  const candle = { open: close, high: close, low: close, close, isComplete: true };
  return {
    symbol, displaySymbol: symbol, timeframe: "M5", assetClass,
    aiUsable: true, stale: false,
    truthState: { isLive: true, stale: false, aiUsable: true, quality: "clean" },
    currentCandle: null, latestClosedCandle: candle,
    candleStats: { barsAnalyzed: 120, direction: "up", lastClose: close },
    fastFlags: { populated: true, momentumBurst: false },
    marketUnderstanding: {
      populated: true,
      trend: { populated: true, regime: "trending", direction: "bullish" },
      levels: { populated: true, levels: [level], nearestSupport: level, nearestResistance: null, eventsRemembered: 0, note: "" },
      candleIntent: { populated: true, latestIntent: "pushing", dominantPressure: "buyers" },
      timeframeAgreement: { populated: false, scalpOnlyWarning: false },
      evidence: { populated: true, direction: "bullish", evidenceFor: [], evidenceAgainst: [], contradictions: [] },
      readiness: { populated: true, score: 60, quality: "C", gates: [], vetoed: false, vetoReason: null },
    },
    setupState: { populated: false, stage: "no_setup", ageBars: null, invalidationCondition: null, invalidationPrice: null },
    decisionState: { populated: true, bias: "bullish", quality: "C", actionability: "watch", vetoed: false, decision: null, note: "" },
    decisionReasoning: { populated: false },
    decisionFork: { populated: false, downgrade: false },
    agentConsensus: { populated: false, note: "shadow", cautions: [], stance: "neutral", conflict: false, protective: false },
    gateOutput: { chartTruthScore: 87, confidentReadAllowed: true, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true,
      blockedReasons: [], primaryBlockReason: null },
    chartTruthScore: { score: 87 },
  } as unknown as ChartIntelligenceState;
}

function sentencesFor(s: ChartIntelligenceState) {
  return buildMarketSentences(s as Omit<ChartIntelligenceState, "marketSentences">);
}

test("sentences print V10 (3 dp) and XAGUSD (4 dp) levels at instrument precision", () => {
  const v10 = sentencesFor(sentenceState("V10", "synthetic", 6123.457, 6130.123));
  assert.match(v10.whatWouldChange.text, /6123\.457\b/);
  assert.doesNotMatch(v10.whatWouldChange.text, /6123\.46\b/);
  const xag = sentencesFor(sentenceState("XAGUSD", "metals", 30.1234, 30.2011));
  assert.match(xag.whatWouldChange.text, /30\.1234\b/);
  const xau = sentencesFor(sentenceState("XAUUSD", "metals", 2400.55, 2405.1));
  assert.match(xau.whatInvalidates.text, /2400\.55\b/);
});

test("level personality reads as words, not the raw token", () => {
  assert.equal(chartLevelPersonalityWords("retest_pending"), "waiting for a retest");
  assert.equal(chartLevelPersonalityWords("trap_zone"), "a possible trap zone");
  assert.equal(chartLevelPersonalityWords("scalp_only"), "scalp-only");
  assert.equal(chartLevelPersonalityWords("defended"), "defended");
});

test("Ruby's nearest-level line uses instrument precision and plain personality words", () => {
  const line = activeLevelLine(sentenceState("XAUUSD", "metals", 2400.5, 2405.1));
  assert.equal(line, "Nearest level: support at 2400.50 (0.10% away), waiting for a retest.");
  const eur = activeLevelLine(sentenceState("EURUSD", "forex", 1.08523, 1.0861));
  assert.match(eur ?? "", /support at 1\.08523 /);
});
