// Truth regression: the chart gate's stale-feed block reason was a fixed
// "Feed is stale — autonomous chart-based actions are blocked until the feed
// is current." Inside a scheduled weekend close the chart feed status itself
// says "Market closed … Not a feed fault, and not live data." (and for a
// session market outside that window, "The market may be closed or the feed
// delayed"). That fixed sentence reached users as the trade-plan chart note
// and Ruby's syncing read. The gate now states the feed's own lag wording;
// the gate decision itself (autonomousChartActionAllowed) is unchanged.
//
// Pure, offline: no provider, DB or broker calls.
// Run: node --import tsx --test --test-force-exit src/lib/data/chart/__qa__/chartGateStaleReason.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCandleTruth } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput } from "../chartGateOutput.js";
import { noBrokerAlignment } from "../brokerPriceAlignment.js";
import { enrichStateWithBrokerAlignment, type ChartIntelligenceState } from "../chartIntelligence.js";
import { truthResultOfState } from "../stateTruthResult.js";
import type { ChartFeedStatus } from "../chartDataService.js";

const epoch = 1_700_000_000_000;
const truth = runCandleTruth(Array.from({ length: 200 }, (_, i) => ({
  time: new Date(epoch + i * 300_000).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1,
})), { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", source: "dev",
  assetClass: "forex", limit: 200, now: epoch + 199 * 300_000 + 60_000 }).truthResult;
const read = { score: 100, label: "Highly Readable" as const, subMetrics: [], primaryConcern: null, note: "Offline fixture" };

const CLOSED_WARNING = "Market closed for Offline fixture since the scheduled weekend close (2026-10-30 22:00 UTC); newest bar opened 2026-10-30 21:55 UTC. Not a feed fault, and not live data.";
function feed(over: Partial<ChartFeedStatus>): ChartFeedStatus {
  return { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", assetClass: "forex",
    source: "dev", isLive: false, lastTickTime: null, lastCandleTime: new Date(epoch).toISOString(), latencyMs: null,
    missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 200,
    stale: true, quality: "stale", warning: CLOSED_WARNING, aiUsable: false, feedReadinessState: null, message: CLOSED_WARNING,
    completenessReason: null, ...over };
}

function staleReason(reasons: string[]): string {
  const r = reasons.find((x) => /autonomous chart-based actions are blocked/i.test(x));
  assert.ok(r, `no stale-feed block reason in ${JSON.stringify(reasons)}`);
  return r;
}

test("a closed market's stale grade is blocked with the feed's own 'market closed' wording, not 'Feed is stale'", () => {
  const status = feed({});
  const score = computeChartTruthScore(truth, status, noBrokerAlignment(null, "UNKNOWN"));
  const gate = computeChartGateOutput(score, read, noBrokerAlignment(null, "UNKNOWN"), truth, status);
  assert.equal(gate.autonomousChartActionAllowed, false, "the gate decision is unchanged");
  const reason = staleReason(gate.blockedReasons);
  assert.doesNotMatch(reason, /Feed is stale/);
  assert.match(reason, /Market closed for Offline fixture since the scheduled weekend close/);
  assert.match(reason, /Not a feed fault/);
});

test("a 24/7 stale feed keeps its measured stale wording", () => {
  const warning = "Feed is stale — newest bar trails the current bar by 4 intervals.";
  const status = feed({ warning, assetClass: "crypto" });
  const score = computeChartTruthScore(truth, status, noBrokerAlignment(null, "UNKNOWN"));
  const gate = computeChartGateOutput(score, read, noBrokerAlignment(null, "UNKNOWN"), truth, status);
  assert.match(staleReason(gate.blockedReasons), /newest bar trails the current bar by 4 intervals/);
});

test("a stale flag on a feed graded for something else (partial) keeps the generic stale reason", () => {
  const status = feed({ quality: "partial", warning: "Incomplete sequence: 2 missing, 0 duplicate, 0 out-of-order bar(s)." });
  const score = computeChartTruthScore(truth, status, noBrokerAlignment(null, "UNKNOWN"));
  const gate = computeChartGateOutput(score, read, noBrokerAlignment(null, "UNKNOWN"), truth, status);
  const reason = staleReason(gate.blockedReasons);
  assert.doesNotMatch(reason, /Incomplete sequence/);
  assert.match(reason, /not current/i);
});

test("a boolean stale flag (no feed wording) still blocks with the generic reason", () => {
  const score = computeChartTruthScore(truth, feed({}), noBrokerAlignment(null, "UNKNOWN"));
  const gate = computeChartGateOutput(score, read, noBrokerAlignment(null, "UNKNOWN"), truth, true);
  assert.equal(gate.autonomousChartActionAllowed, false);
  staleReason(gate.blockedReasons);
});

// A complete engine state (A-grade bullish read). The enrichment re-derives the
// decision summary and sentences from these engine outputs under the rebuilt
// gate, so a bare { chartReadScore } is no longer a usable state.
function engineState(status: ChartFeedStatus): ChartIntelligenceState {
  const level = (kind: "support" | "resistance", price: number, distancePct: number) => ({
    kind, price, touches: 3, firstTouchAt: null, lastTouchAt: null, strengthScore: 80, weaknessScore: 10,
    trapScore: 0, distancePct,
  });
  const evidence = { populated: true, direction: "bullish", evidenceFor: [], evidenceAgainst: [], contradictions: [], note: "" };
  const readiness = { populated: true, score: 84, quality: "A", gates: [], vetoed: false, vetoReason: null, note: "Readiness 84 (A)." };
  return {
    symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", assetClass: "forex",
    aiUsable: false, stale: true, truthState: status,
    currentCandle: null, latestClosedCandle: null,
    candleStats: { barsAnalyzed: 200, direction: "flat", lastClose: 1.1, changeAbs: 0, changePct: 0,
      range: 0.002, body: 0, avgRange: 0.002, atr: 0.002 },
    fastFlags: { populated: true, momentumBurst: false, nearRecentHigh: false, nearRecentLow: false, note: null },
    marketUnderstanding: {
      populated: true,
      trend: { populated: true, regime: "trending", direction: "bullish" },
      levels: { populated: true, levels: [level("support", 1.0992, -0.07), level("resistance", 1.102, 0.18)],
        nearestSupport: level("support", 1.0992, -0.07), nearestResistance: level("resistance", 1.102, 0.18),
        eventsRemembered: 0, note: "" },
      candleIntent: { populated: true, latestIntent: "pushing", dominantPressure: "buyers" },
      timeframeAgreement: { populated: true, agreementScore: 80, alignedDirection: "bullish", scalpOnlyWarning: false },
      evidence, readiness, note: "",
    },
    setupState: { populated: true, stage: "entry_valid", direction: "bullish", ageBars: 2, decayScore: 10, freshness: 90,
      invalidationPrice: 1.0985, invalidationCondition: null },
    decisionState: { populated: true, bias: "bullish", quality: "A", actionability: "ready", vetoed: false,
      decision: "ready — long bias, quality A", note: "Read-only summary of the engine outputs." },
    decisionReasoning: { populated: false },
    decisionFork: { populated: true, downgrade: false, downgradeReason: null },
    agentConsensus: { populated: false, note: "shadow", cautions: [] },
    trendlineOverlay: { visible: false },
    speedState: {},
    lastUpdated: new Date(epoch).toISOString(),
    chartReadScore: read,
  } as unknown as ChartIntelligenceState;
}

test("broker-alignment enrichment rebuilds the gate with the same feed wording", () => {
  const status = feed({});
  const state = engineState(status);
  const enriched = enrichStateWithBrokerAlignment(state, truth, status, {
    chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex", brokerBid: null, brokerAsk: null, spreadPoints: null,
  });
  assert.match(staleReason(enriched.gateOutput.blockedReasons), /Market closed/);
  // The closed-market stale gate also keeps the A-grade summary off "ready".
  assert.equal(enriched.gateOutput.autonomousChartActionAllowed, false);
  assert.equal(enriched.decisionState.actionability, "watch");
  // The enriched state keeps its truth result beside it (for the seam check),
  // never as a serialized field.
  assert.equal(truthResultOfState(enriched), truth);
  assert.equal(JSON.stringify(enriched).includes("truthResult"), false);
});

test("every chart-intelligence gate build passes the feed status, not only its stale flag", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../chartIntelligence.ts"), "utf8");
  const calls = [...src.matchAll(/computeChartGateOutput\(([\s\S]*?)\);/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 2);
  for (const args of calls) {
    assert.doesNotMatch(args, /feedStatus\.stale/);
    assert.match(args, /feedStatus,?\s*$/);
  }
});
