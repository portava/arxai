// Task #408 — Scanner / Ruby feed-truth honesty (api-server, pure).
//
// Proves three honesty contracts over simulator/non-live data:
//   1. computeFinalRead truth-cap: a SIMULATOR row is analysisOnly, carries the
//      ANALYSIS_ONLY_LABEL, is floored to LOW confidence, and can NEVER be a
//      TRADE_WATCH (actionable) read.
//   2. Viewer projection: a non-privileged viewer never sees simulator-derived
//      indicator numbers — they are masked to an honest waiting-for-feed state;
//      ADMIN/OWNER still see full detail; non-simulator rows pass through.
//   3. Forbidden-phrase guard neutralises confident trade language on any read
//      whose feed is not clean.
//
// Pure, no IO. Run: node --import tsx --test src/lib/honesty/__qa__/feedTruthCopy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeFinalRead,
  ANALYSIS_ONLY_LABEL,
  type ScannerOpportunity,
} from "../../marketScanner.js";
import {
  neutralizeFeedCopy,
  neutralizeFeedCopyDeep,
  containsForbiddenFeedPhrase,
  maskSimulatedOpportunity,
  projectOpportunitiesForViewer,
  viewerSeesSimulatorDetail,
} from "../feedTruthCopy.js";

function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "TREND_CONTINUATION",
    confidenceScore: 82,
    riskScore: 30,
    entrySniperScore: 70,
    riskRewardRatio: 2.4,
    reasonForTrade: "higher highs and higher lows",
    reasonToAvoid: "",
    rulesPassed: ["trend", "structure"],
    rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 84,
      label: "STRONG",
      factors: {
        trendAlignment: 14,
        supportResistanceQuality: 12,
        entryTiming: 12,
        riskRewardQuality: 13,
        volatilityCondition: 9,
        spreadCondition: 9,
        strategyMatch: 8,
        aiConfidenceCalibration: 7,
      },
    },
    entry: 1.12,
    stopLoss: 1.115,
    takeProfit: 1.132,
    generatedAt: "2026-06-09T12:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
    ...over,
  };
}

// ── 1. computeFinalRead truth cap ────────────────────────────────────────────

test("LIVE_FEED clean row can be an actionable TRADE_WATCH (control)", () => {
  const read = computeFinalRead(opp({ dataSource: "LIVE_FEED", chartConfirmed: true }));
  assert.equal(read.analysisOnly, false);
  assert.equal(read.analysisLabel, undefined);
  assert.equal(read.label, "TRADE_WATCH");
});

test("SIMULATOR row is analysis-only, labelled, LOW, and NEVER TRADE_WATCH", () => {
  const read = computeFinalRead(opp({ dataSource: "SIMULATOR", chartConfirmed: true }));
  assert.equal(read.analysisOnly, true, "simulator read must be analysisOnly");
  assert.equal(read.analysisLabel, ANALYSIS_ONLY_LABEL, "must carry the analysis banner");
  assert.equal(read.confidence, "LOW", "simulator floored to LOW confidence");
  assert.notEqual(read.label, "TRADE_WATCH", "simulator can never be actionable");
});

test("AWAITING_FEED row is non-actionable but not analysis-only", () => {
  const read = computeFinalRead(opp({ dataSource: "AWAITING_FEED", chartConfirmed: true }));
  assert.equal(read.analysisOnly, false);
  assert.notEqual(read.label, "TRADE_WATCH");
});

// ── 2. Viewer projection (masking) ───────────────────────────────────────────

test("viewerSeesSimulatorDetail only for ADMIN/OWNER", () => {
  assert.equal(viewerSeesSimulatorDetail("ADMIN"), true);
  assert.equal(viewerSeesSimulatorDetail("OWNER"), true);
  assert.equal(viewerSeesSimulatorDetail("USER"), false);
  assert.equal(viewerSeesSimulatorDetail(null), false);
  assert.equal(viewerSeesSimulatorDetail(undefined), false);
});

test("maskSimulatedOpportunity strips every simulator-derived indicator number", () => {
  const masked = maskSimulatedOpportunity(opp({ dataSource: "SIMULATOR" }));
  assert.equal(masked.confidenceScore, 0);
  assert.equal(masked.riskScore, 0);
  assert.equal(masked.entrySniperScore, 0);
  assert.equal(masked.riskRewardRatio, 0);
  assert.equal(masked.entry, 0);
  assert.equal(masked.stopLoss, 0);
  assert.equal(masked.takeProfit, 0);
  assert.equal(masked.opportunity.score, 0);
  // Fail-closed: every nested simulator-derived factor number is zeroed too.
  for (const [k, v] of Object.entries(masked.opportunity.factors)) {
    assert.equal(v, 0, `factor ${k} must be masked to 0`);
  }
  assert.equal(masked.statusBadge, "WAIT_FOR_CONFIRMATION");
  assert.equal(masked.finalRead?.analysisOnly, true);
  assert.equal(masked.chartConfirmed, false);
});

test("maskSimulatedOpportunity leaves non-simulator rows untouched", () => {
  const live = opp({ dataSource: "LIVE_FEED" });
  assert.deepEqual(maskSimulatedOpportunity(live), live);
  const awaiting = opp({ dataSource: "AWAITING_FEED" });
  assert.deepEqual(maskSimulatedOpportunity(awaiting), awaiting);
});

test("projectOpportunitiesForViewer masks for non-admin, preserves for admin", () => {
  const rows = [opp({ dataSource: "SIMULATOR", symbol: "EURUSD" }), opp({ dataSource: "LIVE_FEED", symbol: "GBPUSD" })];

  const asUser = projectOpportunitiesForViewer(rows, "USER");
  assert.equal(asUser[0]!.confidenceScore, 0, "user must not see simulator confidence");
  assert.equal(asUser[1]!.confidenceScore, 82, "live row unchanged for user");

  const asAdmin = projectOpportunitiesForViewer(rows, "ADMIN");
  assert.equal(asAdmin[0]!.confidenceScore, 82, "admin sees full simulator detail");
});

// ── 3. Forbidden-phrase guard ────────────────────────────────────────────────

test("neutralizeFeedCopy replaces confident trade language", () => {
  const out = neutralizeFeedCopy("Verified setup — strong buy, trade now. Final trade read.");
  assert.equal(containsForbiddenFeedPhrase(out), false, `still confident: ${out}`);
  assert.match(out, /unverified setup/i);
  assert.match(out, /wait for confirmation/i);
});

test("neutralizeFeedCopyDeep scrubs nested strings, preserves numbers/booleans", () => {
  const payload = {
    headline: "Strong sell — trade now",
    score: 84,
    actionable: true,
    reasons: ["Verified setup", "clean structure"],
    nested: { note: "final trade read" },
  };
  const out = neutralizeFeedCopyDeep(payload);
  assert.equal(out.score, 84);
  assert.equal(out.actionable, true);
  assert.equal(containsForbiddenFeedPhrase(out.headline), false);
  assert.equal(containsForbiddenFeedPhrase(out.reasons[0]!), false);
  assert.equal(containsForbiddenFeedPhrase(out.nested.note), false);
});

test("containsForbiddenFeedPhrase is stable across repeated calls (no lastIndex leak)", () => {
  const s = "strong buy";
  assert.equal(containsForbiddenFeedPhrase(s), true);
  assert.equal(containsForbiddenFeedPhrase(s), true);
});
