// Task #600 — Assertion #8 BACKEND lock: "scanner scores are not placeholders /
// generic defaults". The frontend render proof (BroadScanOpportunityMap.test.tsx)
// shows the UI faithfully echoes whatever Edge/Entry/Exec the backend produces —
// but that test would still pass if the backend returned a constant for every
// symbol. This file closes that gap by exercising the REAL per-row derivation in
// opportunityMapService (the same `toInput` the live map runs) with two
// controlled, distinct ScannerOpportunity inputs and asserting the resulting
// Edge / Entry / Exec are each derived from per-row evidence — never a shared
// default.
//
// Run via:
//   node --import tsx --test --test-force-exit \
//     src/lib/signalIntelligence/__qa__/opportunityScoreDerivation.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:opportunity-score-derivation`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toInput,
  executionQualityFor,
} from "../opportunityMapService.js";
import type { ScannerOpportunity } from "../../marketScanner.js";

// Minimal ScannerOpportunity factory — only the fields the derivation under test
// actually reads are meaningful; the rest are filled with honest placeholders and
// cast once. This keeps the test focused on the score-derivation read paths
// (effectiveOpportunityScore + entrySniperScore passthrough + executionQualityFor)
// without coupling to the full (large) scan-row shape.
function mkOpp(overrides: Partial<ScannerOpportunity>): ScannerOpportunity {
  const base = {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "retest",
    confidenceScore: 50,
    riskScore: 50,
    entrySniperScore: 50,
    riskRewardRatio: 2,
    reasonForTrade: "test",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "READY",
    opportunity: { score: 50 },
    entry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    generatedAt: new Date().toISOString(),
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
  };
  return { ...base, ...overrides } as unknown as ScannerOpportunity;
}

const ALL_DATA_SOURCES: ScannerOpportunity["dataSource"][] = [
  "LIVE_FEED",
  "LIVE_DELAYED",
  "STALE_FEED",
  "HISTORY_READY_AWAITING_LIVE_TICK",
  "AWAITING_FEED",
  "SIMULATOR",
];

test("#8 two distinct rows produce distinct, evidence-derived Edge/Entry/Exec (never a shared default)", () => {
  const a = toInput(
    mkOpp({
      symbol: "EURUSD",
      recommendedAction: "BUY",
      opportunity: { score: 72 } as ScannerOpportunity["opportunity"],
      entrySniperScore: 64,
      dataSource: "LIVE_FEED",
      dataStatus: "live",
    }),
    null,
  );
  const b = toInput(
    mkOpp({
      symbol: "GBPUSD",
      recommendedAction: "SELL",
      opportunity: { score: 41 } as ScannerOpportunity["opportunity"],
      entrySniperScore: 88,
      dataSource: "LIVE_DELAYED",
      dataStatus: "live",
    }),
    null,
  );

  // Edge tracks the per-row opportunity score (effectiveOpportunityScore).
  assert.equal(a.edgeScore, 72);
  assert.equal(b.edgeScore, 41);
  // Entry tracks the per-row entrySniperScore (rounded passthrough).
  assert.equal(a.entryQuality, 64);
  assert.equal(b.entryQuality, 88);
  // Exec tracks the per-row feed status, not the symbol.
  assert.equal(a.executionQuality, 80); // LIVE_FEED
  assert.equal(b.executionQuality, 35); // LIVE_DELAYED

  // The anti-placeholder invariant: distinct evidence => distinct verdicts. If
  // the backend ever collapsed to a constant (e.g. Edge 78 / Entry 75 / Exec 80
  // for every symbol), all three of these would fail.
  assert.notEqual(a.edgeScore, b.edgeScore);
  assert.notEqual(a.entryQuality, b.entryQuality);
  assert.notEqual(a.executionQuality, b.executionQuality);
});

test("#8 entryQuality rounds the real entrySniperScore (not a fixed value)", () => {
  for (const sniper of [0, 33.4, 33.6, 71, 100]) {
    const row = toInput(mkOpp({ entrySniperScore: sniper }), null);
    assert.equal(row.entryQuality, Math.round(sniper));
  }
});

test("#8 executionQuality is a real function of feed status — every source maps to its own honest value", () => {
  const bySource = new Map(
    ALL_DATA_SOURCES.map((ds) => [ds, executionQualityFor(ds)]),
  );
  // Exact honest mapping (live > delayed > history > stale > awaiting > sim=0).
  assert.equal(bySource.get("LIVE_FEED"), 80);
  assert.equal(bySource.get("LIVE_DELAYED"), 35);
  assert.equal(bySource.get("HISTORY_READY_AWAITING_LIVE_TICK"), 40);
  assert.equal(bySource.get("STALE_FEED"), 30);
  assert.equal(bySource.get("AWAITING_FEED"), 20);
  assert.equal(bySource.get("SIMULATOR"), 0);
  // A real live feed must out-rank a non-live one — and SIMULATOR can never
  // claim execution quality (no sim leak into a tradeable verdict).
  assert.ok(
    bySource.get("LIVE_FEED")! > bySource.get("LIVE_DELAYED")!,
    "live must out-rank delayed",
  );
  assert.equal(bySource.get("SIMULATOR"), 0);
  // Not a single constant: the distinct values prove exec quality is derived.
  assert.ok(new Set(bySource.values()).size >= 5);
});

test("#8 edgeScore honours the protective governance/advisory override (not blindly opportunity.score)", () => {
  // Governance is bounded + PROTECTIVE: rankingScore (<= advisory) wins over the
  // raw opportunity score, so the edge reflects the real governed ranking.
  const governed = toInput(
    mkOpp({
      opportunity: { score: 90 } as ScannerOpportunity["opportunity"],
      agentGovernance: { rankingScore: 55 } as ScannerOpportunity["agentGovernance"],
    }),
    null,
  );
  assert.equal(governed.edgeScore, 55);

  // With no governance, the advisory-adjusted score wins over the raw score.
  const advised = toInput(
    mkOpp({
      opportunity: { score: 90 } as ScannerOpportunity["opportunity"],
      agentAdvisory: { adjustedScore: 47 } as ScannerOpportunity["agentAdvisory"],
    }),
    null,
  );
  assert.equal(advised.edgeScore, 47);

  // The timing heatBoost is folded additively on top of the governed score.
  const boosted = toInput(
    mkOpp({
      opportunity: { score: 90 } as ScannerOpportunity["opportunity"],
      agentGovernance: { rankingScore: 55 } as ScannerOpportunity["agentGovernance"],
      timingContext: { heatBoost: 7 } as ScannerOpportunity["timingContext"],
    }),
    null,
  );
  assert.equal(boosted.edgeScore, 62);
});

test("#8 hasLiveData is derived from resolved dataStatus, not the raw feed tag", () => {
  // A row tagged LIVE_FEED but with too few bars to analyse has dataStatus forced
  // to no_data upstream — it must NOT claim live data.
  const unanalysable = toInput(
    mkOpp({ dataSource: "LIVE_FEED", dataStatus: "no_data" }),
    null,
  );
  assert.equal(unanalysable.hasLiveData, false);

  const live = toInput(
    mkOpp({ dataSource: "LIVE_FEED", dataStatus: "live" }),
    null,
  );
  assert.equal(live.hasLiveData, true);
});

test("#790 a feed-too-thin row downgraded to AWAITING_FEED shows honest low feed-readiness, never a default live Exec 80", () => {
  // Task #790: marketScanner now downgrades a LIVE_FEED row with too few closed
  // bars to analyse to dataSource:"AWAITING_FEED" + dataStatus:"no_data" (it is
  // no longer left tagged LIVE_FEED). The map row must then reflect the HONEST
  // feed-readiness value (20), never the full-confidence live value (80), and
  // must not claim live data — so an unanalysable feed can't surface a default
  // "Feed/Exec 80" as if it were a real live score.
  const downgraded = toInput(
    mkOpp({ dataSource: "AWAITING_FEED", dataStatus: "no_data" }),
    null,
  );
  assert.equal(downgraded.executionQuality, 20);
  assert.equal(downgraded.hasLiveData, false);
  // Prove the downgrade matters: the SAME row left tagged LIVE_FEED would have
  // surfaced the misleading 80. The reassignment in marketScanner is what makes
  // the honest 20 reachable here.
  assert.equal(executionQualityFor("LIVE_FEED"), 80);
  assert.notEqual(downgraded.executionQuality, executionQualityFor("LIVE_FEED"));
});
