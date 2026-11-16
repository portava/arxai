import test from "node:test";
import assert from "node:assert/strict";
import { computeEvidenceStack } from "../engines/evidenceStack.js";
import type { ChartTrendRead, ChartLevelsRead, ChartCandleIntentRead, ChartTimeframeAgreement, ChartLevel } from "../engines/marketUnderstandingTypes.js";
import type { ChartSetupRead } from "../engines/setupLifecycle.js";
function inputs(direction: "bullish" | "bearish") {
  const trend: ChartTrendRead = { populated: true, direction, regime: "trending", strength: 100, slope: direction === "bullish" ? 1 : -1, higherTimeframeBias: "unknown", note: "" };
  const level: ChartLevel = { kind: direction === "bullish" ? "support" : "resistance", price: 100, personality: "retest_pending", touchCount: 4, rejectionCount: 1, breakCount: 1, retestCount: 1, strengthScore: 100, weaknessScore: 100, trapScore: 0, distancePct: 0.1 };
  const levels: ChartLevelsRead = { populated: true, levels: [level], nearestSupport: direction === "bullish" ? level : null, nearestResistance: direction === "bearish" ? level : null, eventsRemembered: 0, note: "" };
  const intent: ChartCandleIntentRead = { populated: true, latestIntent: "continuing", dominantPressure: "balanced", signals: [], note: "" };
  const setup: ChartSetupRead = { populated: true, hasActiveSetup: false, stage: "idea_forming", tradeType: "scalp", direction, freshness: 100, decayScore: 0, ageBars: 0, expiresInBars: 8, invalidationCondition: null, invalidationPrice: null, note: "" };
  const tf: ChartTimeframeAgreement = { populated: false, agreementScore: null, alignedDirection: "unknown", scalpOnlyWarning: false, timeframes: [], computedAt: null, note: "" };
  return { trend, levels, intent, setup, tf, level };
}
for (const direction of ["bullish", "bearish"] as const) {
  test(`weak levels and balanced pressure do not invert ${direction} trend evidence`, () => {
    const x = inputs(direction); const r = computeEvidenceStack(x.trend,x.levels,x.intent,x.setup,x.tf);
    assert.equal(r.direction, "neutral");
    assert.ok(r.evidenceFor.some(e => e.source === "trend" && e.text.includes(direction)));
    assert.equal(r.evidenceAgainst.length, 2);
    assert.ok(r.note.includes(`against the ${direction} idea`));
    assert.ok(r.note.includes("does not confirm a direction"));
  });
  test(`aligned ${direction} evidence retains its supported direction`, () => {
    const x = inputs(direction); x.level.personality = "defended"; x.level.weaknessScore = 0; x.intent.dominantPressure = direction === "bullish" ? "buyers" : "sellers";
    const r = computeEvidenceStack(x.trend,x.levels,x.intent,x.setup,x.tf);
    assert.equal(r.direction,direction); assert.equal(r.evidenceAgainst.length,0);
  });
}
test("unpopulated structure stays unknown", () => {
  const x=inputs("bullish"); x.trend.populated=false;
  assert.equal(computeEvidenceStack(x.trend,x.levels,x.intent,x.setup,x.tf).direction,"unknown");
});
