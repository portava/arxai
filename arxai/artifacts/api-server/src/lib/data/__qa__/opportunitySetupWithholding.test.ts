// ── Adversarial: Ruby chat/tool setup-level withholding ─────────────────────
//
// Task #600 (reopened half). The dangerous bug class: Ruby's conversational
// CHAT/TOOL path handing a user a full decimal trade setup (entry / stop loss /
// TP1-3 / R:R) while the shared sufficiency verdict — the SAME verdict the Ruby
// Chart Read panel uses — does NOT permit a directional read. A prompt caveat is
// not a control; the CODE must withhold the levels.
//
// These tests target the shared assembly boundary (projectOpportunitySetup) that
// BOTH chat surfaces route through (getMarketScannerOpportunities and
// scannerOpportunityToLiveCandidate → opportunityRadar). They build verdicts via
// the REAL evaluateMarketDataSufficiency so chart and chat are proven to share
// one reason, then assert that an insufficient / partial / stale / awaiting /
// blocked / missing verdict leaks NO entry/SL/TP/targets/R:R anywhere (including
// alternate field names) and returns an honest withheld state instead.
//
// Withhold-only: this is display gating. It never touches the 16/18-gate live
// dispatch path, never grants/sizes/places a trade, and the verdict never enters
// an execution module.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectOpportunitySetup,
  sufficiencyAllowsSetup,
  scannerOpportunityToLiveCandidate,
  SETUP_WITHHELD_SAFE_MESSAGE,
} from "../opportunityAdapters.js";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import type { ScannerOpportunity } from "../../marketScanner.js";

// Distinctive decimal strings so a stringify leak-scan can't false-match an ISO
// timestamp or an unrelated integer.
const ENTRY = 1.23456;
const STOP = 1.22000;
const TAKE = 1.25000;

function mkOpp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "trend-continuation",
    confidenceScore: 80,
    riskScore: 30,
    entrySniperScore: 70,
    riskRewardRatio: 2.0,
    reasonForTrade: "test setup",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "READY",
    opportunity: {
      score: 85,
      label: "STRONG",
      factors: {
        trendAlignment: 12,
        supportResistanceQuality: 12,
        entryTiming: 12,
        riskRewardQuality: 12,
        volatilityCondition: 8,
        spreadCondition: 8,
        strategyMatch: 8,
        aiConfidenceCalibration: 8,
      },
    },
    entry: ENTRY,
    stopLoss: STOP,
    takeProfit: TAKE,
    generatedAt: "2026-06-16T00:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    ...over,
  } as ScannerOpportunity;
}

const sufficientVerdict = evaluateMarketDataSufficiency({
  symbol: "EURUSD",
  timeframe: "M15",
  freshnessVerdict: "LIVE",
  availableClosedCandles: 100,
});
const insufficientVerdict = evaluateMarketDataSufficiency({
  symbol: "EURUSD",
  timeframe: "M15",
  freshnessVerdict: "LIVE",
  availableClosedCandles: 1,
});
const staleVerdict = evaluateMarketDataSufficiency({
  symbol: "EURUSD",
  timeframe: "M15",
  freshnessVerdict: "LIVE_DELAYED",
  availableClosedCandles: 100,
});
const awaitingVerdict = evaluateMarketDataSufficiency({
  symbol: "EURUSD",
  timeframe: "M15",
  freshnessVerdict: "AWAITING",
  availableClosedCandles: 100,
});
const blockedVerdict = evaluateMarketDataSufficiency({
  symbol: "NOT_AN_ARX_MARKET",
  timeframe: "M15",
  freshnessVerdict: "LIVE",
  availableClosedCandles: 100,
});

// Sanity: the verdict fixtures are what we think they are (locks chart/chat to
// the same upstream contract).
test("verdict fixtures: only the sufficient verdict allows a setup", () => {
  assert.equal(sufficientVerdict.canShowTradeSetup, true);
  assert.equal(insufficientVerdict.canShowTradeSetup, false);
  assert.equal(staleVerdict.canShowTradeSetup, false);
  assert.equal(awaitingVerdict.canShowTradeSetup, false);
  assert.equal(blockedVerdict.canShowTradeSetup, false);
});

test("sufficient verdict → real directional setup is produced", () => {
  const o = mkOpp({ sufficiency: sufficientVerdict });
  assert.equal(sufficiencyAllowsSetup(o), true);
  const s = projectOpportunitySetup(o);
  assert.equal(s.setupWithheld, false);
  assert.equal(s.withheldReason, null);
  assert.equal(s.withheldReasonCode, null);
  assert.equal(s.withheldMessage, null);
  assert.equal(s.entry, ENTRY);
  assert.equal(s.stopLoss, STOP);
  assert.equal(typeof s.takeProfit, "number");
  assert.equal(s.riskRewardRatio, 2.0);
  assert.ok(s.takeProfitTargets.length > 0, "expected take-profit targets");
  assert.ok(s.bestTargetLabel !== null, "expected a best target label");
});

// The heart of the task: every non-sufficient + missing verdict must withhold
// EVERY level, with the chart-panel-identical reason.
const withheldCases: Array<{ name: string; verdict: ScannerOpportunity["sufficiency"] | undefined; reasonCode: string | null }> = [
  { name: "insufficient (too few bars)", verdict: insufficientVerdict, reasonCode: "not_enough_bars" },
  { name: "partial / stale (delayed feed)", verdict: staleVerdict, reasonCode: "stale_feed" },
  { name: "partial / awaiting (no current feed)", verdict: awaitingVerdict, reasonCode: "feed_unavailable" },
  { name: "blocked (not an approved market)", verdict: blockedVerdict, reasonCode: "source_not_ai_usable" },
  { name: "missing verdict (fail-closed)", verdict: undefined, reasonCode: null },
];

for (const c of withheldCases) {
  test(`withheld: ${c.name} → no entry/SL/TP/targets/R:R anywhere`, () => {
    const o = mkOpp({ sufficiency: c.verdict });
    assert.equal(sufficiencyAllowsSetup(o), false);
    const s = projectOpportunitySetup(o);

    // No directional levels — including the legacy/alternate carriers.
    assert.equal(s.entry, null);
    assert.equal(s.stopLoss, null);
    assert.equal(s.takeProfit, null);
    assert.equal(s.riskRewardRatio, null);
    assert.deepEqual(s.takeProfitTargets, []);
    assert.equal(s.bestTargetLabel, null);

    // Honest withheld state.
    assert.equal(s.setupWithheld, true);
    assert.equal(s.withheldMessage, SETUP_WITHHELD_SAFE_MESSAGE);
    assert.equal(s.withheldReasonCode, c.reasonCode);

    // Chart/chat agreement: the withheld reason is the SAME human string the
    // Ruby Chart Read panel shows (verdict.humanReason), or the safe default
    // when the verdict is entirely absent.
    const expectedReason = c.verdict?.humanReason ?? SETUP_WITHHELD_SAFE_MESSAGE;
    assert.equal(s.withheldReason, expectedReason);
    assert.equal(s.targetsUnavailableReason, expectedReason);

    // Adversarial: prove no concrete price leaked through ANY field name.
    const blob = JSON.stringify(s);
    for (const leaked of ["1.23456", "1.22000", "1.22", "1.25000", "1.25"]) {
      assert.ok(!blob.includes(leaked), `withheld payload must not contain price ${leaked}`);
    }
  });
}

// The radar consumes scannerOpportunityToLiveCandidate and exposes entry/stop
// under alternate names (keyLevelToWatch = c.entry || null, invalidationLevel =
// c.stopLoss || null). Withheld levels become 0 on the LiveCandidate, so the
// radar's `|| null` coercion yields null — no leaked price via the alt fields.
test("LiveCandidate (radar feed): withheld → levels coerce to null, sufficient → real", () => {
  const withheld = scannerOpportunityToLiveCandidate(mkOpp({ sufficiency: insufficientVerdict }));
  assert.equal(withheld.entry, 0);
  assert.equal(withheld.stopLoss, 0);
  assert.equal(withheld.takeProfit, 0);
  assert.equal(withheld.riskRewardRatio, 0);
  assert.deepEqual(withheld.takeProfitTargets, []);
  // Exactly the radar's coercion (radar.ts fromLiveCandidate):
  assert.equal(withheld.entry || null, null, "radar keyLevelToWatch would leak");
  assert.equal(withheld.stopLoss || null, null, "radar invalidationLevel would leak");

  const ok = scannerOpportunityToLiveCandidate(mkOpp({ sufficiency: sufficientVerdict }));
  assert.equal(ok.entry, ENTRY);
  assert.equal(ok.stopLoss, STOP);
  assert.ok((ok.entry || null) !== null, "sufficient row should carry a real entry");
});

// Missing verdict must fail closed for the radar feed too.
test("LiveCandidate (radar feed): missing verdict fails closed", () => {
  const lc = scannerOpportunityToLiveCandidate(mkOpp({ sufficiency: undefined }));
  assert.equal(lc.entry || null, null);
  assert.equal(lc.stopLoss || null, null);
  assert.deepEqual(lc.takeProfitTargets, []);
});
