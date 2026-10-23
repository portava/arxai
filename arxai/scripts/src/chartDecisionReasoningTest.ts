// Chart Brain v2 — decision-reasoning opposite-scenario regression suite.
//
// Pins the directional correctness of the opposite scenario produced by
// computeDecisionReasoning:
//   - a BULLISH read flipping bearish must project DOWNSIDE (trigger = close
//     below support) and must NOT claim a push toward the upside barrier
//   - a BEARISH read flipping bullish must project UPSIDE (trigger = close
//     above resistance) and must NOT claim a push toward the downside barrier
//   - an unpopulated feed reasons honestly (no fabricated levels)
//
// A prior bug pointed the opposite expectation at the wrong-side barrier price,
// inverting the directional implication for both biases. This test fails closed
// if that inversion ever returns.
//
// SAFETY: pure function test. No DB, no broker calls, no env mutation.

import { computeDecisionReasoning } from "../../artifacts/api-server/src/lib/data/chart/engines/decisionReasoning.js";
import type {
  ChartEvidenceDirection,
  ChartLevel,
  ChartLevelsRead,
  ChartEvidenceRead,
  ChartTrendRead,
} from "../../artifacts/api-server/src/lib/data/chart/engines/marketUnderstandingTypes.js";
import type { ChartSetupRead } from "../../artifacts/api-server/src/lib/data/chart/engines/setupLifecycle.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function level(kind: "support" | "resistance", price: number): ChartLevel {
  return {
    kind,
    price,
    personality: "fresh",
    touchCount: 2,
    rejectionCount: 1,
    breakCount: 0,
    retestCount: 0,
    strengthScore: 50,
    weaknessScore: 10,
    trapScore: 5,
    distancePct: 0.1,
  };
}

function mkLevels(): ChartLevelsRead {
  return {
    populated: true,
    levels: [level("support", 100), level("resistance", 110)],
    nearestSupport: level("support", 100),
    nearestResistance: level("resistance", 110),
    eventsRemembered: 4,
    note: "test levels",
  };
}

function mkTrend(): ChartTrendRead {
  return {
    populated: true,
    direction: "ranging",
    regime: "ranging",
    strength: 40,
    slope: 0,
    higherTimeframeBias: "unknown",
    note: "test trend",
  };
}

function mkEvidence(direction: ChartEvidenceDirection): ChartEvidenceRead {
  return {
    populated: true,
    direction,
    evidenceFor: [{ text: "buyers in control", weight: 60, source: "test" }],
    evidenceAgainst: [],
    contradictions: [],
    note: "test evidence",
  };
}

function mkSetup(): ChartSetupRead {
  return {
    populated: true,
    hasActiveSetup: false,
    stage: "no_setup",
    tradeType: "intraday",
    direction: "none",
    freshness: null,
    decayScore: null,
    ageBars: null,
    expiresInBars: null,
    invalidationCondition: null,
    invalidationPrice: null,
    note: "test setup",
  };
}

// 1) Bullish read → opposite is bearish, must project DOWNSIDE.
{
  const r = computeDecisionReasoning({
    trend: mkTrend(),
    levels: mkLevels(),
    evidence: mkEvidence("bullish"),
    setup: mkSetup(),
  });
  const opp = r.opposite;
  const triggerOk = !!opp && opp.direction === "bearish" && /below support/i.test(opp.trigger);
  const expectsDown = !!opp && /downside/i.test(opp.expectation);
  // The bug: expectation pushed "toward 110" (the upside resistance barrier).
  const noUpsideTarget = !!opp && !/toward\s*110/i.test(opp.expectation) && !/upside/i.test(opp.expectation);
  record(
    "bullish opposite projects downside (not toward resistance)",
    triggerOk && expectsDown && noUpsideTarget,
    opp ? opp.expectation : "no opposite",
  );
}

// 2) Bearish read → opposite is bullish, must project UPSIDE.
{
  const r = computeDecisionReasoning({
    trend: mkTrend(),
    levels: mkLevels(),
    evidence: mkEvidence("bearish"),
    setup: mkSetup(),
  });
  const opp = r.opposite;
  const triggerOk = !!opp && opp.direction === "bullish" && /above resistance/i.test(opp.trigger);
  const expectsUp = !!opp && /upside/i.test(opp.expectation);
  // The bug: expectation pushed "toward 100" (the downside support barrier).
  const noDownsideTarget = !!opp && !/toward\s*100/i.test(opp.expectation) && !/downside/i.test(opp.expectation);
  record(
    "bearish opposite projects upside (not toward support)",
    triggerOk && expectsUp && noDownsideTarget,
    opp ? opp.expectation : "no opposite",
  );
}

// 3) Unpopulated structure reasons honestly — no fabricated levels.
{
  const levels = mkLevels();
  levels.populated = false;
  const r = computeDecisionReasoning({
    trend: mkTrend(),
    levels,
    evidence: mkEvidence("bullish"),
    setup: mkSetup(),
  });
  record(
    "unpopulated structure is honest",
    r.populated === false && r.opposite === null && r.bias === "unknown",
    r.note,
  );
}

const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(
  `\nchartDecisionReasoningTest: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length > 0) process.exit(1);

export {};
