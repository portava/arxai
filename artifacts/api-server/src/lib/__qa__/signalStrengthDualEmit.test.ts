// SIGNAL-STRENGTH RENAME — dual-emit contract (Theme B follow-through).
//
// `signalStrength` is the canonical wire name for the hand-weighted,
// UNCALIBRATED setup heuristic that used to travel only as `confidenceScore`.
// The rename is scoped: uncalibrated heuristics on the wire dual-emit BOTH
// fields (new name canonical, old name deprecated-but-present so no client
// breaks — the same pattern as `takeProfit` vs `takeProfitTargets` in
// liveScanner.ts). Stored/audited predictions (rubySignalOutcomes, the
// calibration engine, tradeDecisions, liveIntents) deliberately KEEP the
// confidence name: there the number is a confidence claim under audit, and
// DB columns are untouched.
//
// This suite proves the contract:
//   1. Every dual-emitting builder emits both fields with the SAME value
//      (runtime where the builder is pure, source-anchored otherwise — the
//      honestConfidence.test.ts idiom).
//   2. The simulator mask withholds (nulls) the NEW field too — a
//      simulator-derived signalStrength may never survive masking.
//   3. The UI surfaces in scope read the canonical field.
//
// Pure source + pure-function analysis — no network, DB, or provider calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { ScannerOpportunity } from "../marketScanner.js";
import { maskSimulatedOpportunity } from "../honesty/feedTruthCopy.js";
import { scannerOpportunityToLiveCandidate } from "../data/opportunityAdapters.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "Continuation",
    signalStrength: 88,
    confidenceScore: 88,
    riskScore: 20,
    entrySniperScore: 80,
    riskRewardRatio: 2,
    reasonForTrade: "Support hold",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 88,
      label: "STRONG",
      factors: {
        trendAlignment: 80, supportResistanceQuality: 80, entryTiming: 80,
        riskRewardQuality: 80, volatilityCondition: 80, spreadCondition: 80,
        strategyMatch: 80, aiConfidenceCalibration: 80,
      },
    },
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: "2026-08-28T00:00:00.000Z",
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

describe("dual-emit: builders emit signalStrength === confidenceScore", () => {
  it("liveScanner emits both fields from the same computed value", () => {
    const src = read("artifacts/api-server/src/lib/assistant/liveScanner.ts");
    assert.ok(/signalStrength: confidence,/.test(src), "LiveCandidate must emit signalStrength");
    assert.ok(/confidenceScore: confidence,/.test(src), "LiveCandidate must keep emitting the deprecated alias");
  });

  it("marketScanner emits both fields from displayConfidenceScore", () => {
    const src = read("artifacts/api-server/src/lib/marketScanner.ts");
    assert.ok(/signalStrength: displayConfidenceScore,/.test(src));
    assert.ok(/confidenceScore: displayConfidenceScore,/.test(src));
  });

  it("selectedMarket emits both fields in the real AND the honest-waiting envelope", () => {
    const src = read("artifacts/api-server/src/lib/scannerSelected/selectedMarket.ts");
    assert.ok(/signalStrength: Math\.round\(a\.confidenceScore\),/.test(src));
    assert.ok(/confidenceScore: Math\.round\(a\.confidenceScore\),/.test(src));
    // Waiting envelope: both honest zeros, never a fabricated value.
    assert.ok(/signalStrength: 0,\s*\n\s*confidenceScore: 0,/.test(src));
  });

  it("rubyDraftRead emits both from the readiness score and neutralizes both to null", () => {
    const src = read("artifacts/api-server/src/lib/assistant/rubyDraftRead.ts");
    assert.ok(/signalStrength: state\.marketUnderstanding\.readiness\.score,/.test(src));
    assert.ok(/confidenceScore: state\.marketUnderstanding\.readiness\.score,/.test(src));
    // Gate-blocked reads must withhold BOTH names — never a directional leak
    // through the new field.
    assert.ok(/r\.signalStrength = null;\s*\n\s*r\.confidenceScore = null;/.test(src));
  });

  it("explain-signal setupReason emits both and accepts both on input", () => {
    const src = read("artifacts/api-server/src/routes/meAssistant.ts");
    assert.ok(/signalStrength: z\.number\(\)\.min\(0\)\.max\(100\)\.optional\(\),/.test(src), "input schema accepts the canonical name");
    assert.ok(/const conf = s\.signalStrength \?\? s\.confidenceScore \?\? 0;/.test(src), "canonical name wins on input");
    assert.ok(/signalStrength: conf,\s*\n\s*confidenceScore: conf,/.test(src), "setupReason dual-emits");
  });

  it("scannerOpportunityToLiveCandidate carries both fields through, equal", () => {
    const lc = scannerOpportunityToLiveCandidate(opp());
    assert.equal(lc.signalStrength, lc.confidenceScore);
    assert.equal(lc.signalStrength, 88);
  });
});

describe("dual-emit: the simulator mask withholds the new field too", () => {
  it("SIMULATOR rows: both fields withheld as null (no residual heuristic survives)", () => {
    const masked = maskSimulatedOpportunity(opp({ dataSource: "SIMULATOR" }));
    assert.equal(masked.signalStrength, null);
    assert.equal(masked.confidenceScore, null);
  });

  it("LIVE_FEED rows pass through unchanged with both fields equal", () => {
    const live = maskSimulatedOpportunity(opp());
    assert.equal(live.signalStrength, live.confidenceScore);
    assert.equal(live.signalStrength, 88);
  });
});

describe("dual-emit: UI surfaces read the canonical field", () => {
  const CASES: Array<[string, string, RegExp]> = [
    ["live-ai-assist renders signalStrength", "artifacts/trading-dashboard/src/pages/live-ai-assist.tsx", /card\.signalStrength/],
    ["market-scanner reads signalStrength (with alias fallback)", "artifacts/trading-dashboard/src/pages/market-scanner.tsx", /o\.signalStrength \?\? o\.confidenceScore/],
    ["ScannerTradeModal reads signalStrength (with alias fallback)", "artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx", /signal\.signalStrength \?\? signal\.confidenceScore/],
    ["RubyDraftReadPanel reads signalStrength (with alias fallback)", "artifacts/trading-dashboard/src/components/charts/RubyDraftReadPanel.tsx", /read\.signalStrength \?\? read\.confidenceScore/],
  ];
  for (const [name, rel, re] of CASES) {
    it(name, () => {
      assert.ok(re.test(read(rel)), `${rel} must read the canonical signalStrength field`);
    });
  }

  it("the OpenAPI spec declares signalStrength and deprecates confidenceScore on RubyDraftRead", () => {
    const spec = read("lib/api-spec/openapi.yaml");
    assert.ok(/signalStrength: \{ type: \["number", "null"\]/.test(spec));
    assert.ok(/confidenceScore: \{ type: \["number", "null"\], deprecated: true/.test(spec));
  });
});
