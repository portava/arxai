// Chart Brain v2 — Task 2, Engine 5: evidence stack + contradiction detector.
//
// Collects weighted, human-readable evidence FOR and AGAINST a directional bias
// from the other engine reads (trend, levels, candle intent, setup, timeframe
// agreement), nets it into a direction, and flags explicit contradictions
// (e.g. bullish intent into defended resistance, lower/higher TF conflict). All
// evidence text is derived from real engine output — never invented.

import { clamp, round } from "./chartMath.js";
import type {
  ChartCandleIntentRead,
  ChartContradiction,
  ChartEvidenceDirection,
  ChartEvidenceItem,
  ChartEvidenceRead,
  ChartLevelsRead,
  ChartTimeframeAgreement,
  ChartTrendRead,
} from "./marketUnderstandingTypes.js";
import type { ChartSetupRead } from "./setupLifecycle.js";

type Dir = "bullish" | "bearish";

export function computeEvidenceStack(
  trend: ChartTrendRead,
  levels: ChartLevelsRead,
  candleIntent: ChartCandleIntentRead,
  setup: ChartSetupRead,
  tfAgreement: ChartTimeframeAgreement,
): ChartEvidenceRead {
  if (!trend.populated || !levels.populated) {
    return {
      populated: false,
      direction: "unknown",
      evidenceFor: [],
      evidenceAgainst: [],
      contradictions: [],
      note: "Not enough structure to assemble evidence.",
    };
  }

  // Net the candidate direction from the trend; fall back to setup direction.
  let candidate: Dir | null = null;
  if (trend.direction === "bullish") candidate = "bullish";
  else if (trend.direction === "bearish") candidate = "bearish";
  else if (setup.direction === "bullish") candidate = "bullish";
  else if (setup.direction === "bearish") candidate = "bearish";

  if (!candidate) {
    return {
      populated: true,
      direction: trend.direction === "ranging" ? "neutral" : "unknown",
      evidenceFor: [],
      evidenceAgainst: [],
      contradictions: [],
      note: "No directional bias — market is ranging/mixed.",
    };
  }

  const evidenceFor: ChartEvidenceItem[] = [];
  const evidenceAgainst: ChartEvidenceItem[] = [];
  const contradictions: ChartContradiction[] = [];

  const bias = candidate;
  const supports = (good: boolean, item: ChartEvidenceItem) => {
    if (good) evidenceFor.push(item);
    else evidenceAgainst.push(item);
  };

  // Trend.
  const trendAligned =
    (bias === "bullish" && trend.direction === "bullish") ||
    (bias === "bearish" && trend.direction === "bearish");
  supports(trendAligned, {
    text: `${trend.regime} ${trend.direction} trend (strength ${trend.strength ?? 0})`,
    weight: round(clamp((trend.strength ?? 0) * 0.9)),
    source: "trend",
  });

  // Higher-timeframe bias from the trend read.
  if (trend.higherTimeframeBias === "bullish" || trend.higherTimeframeBias === "bearish") {
    const htfAligned = trend.higherTimeframeBias === bias;
    supports(htfAligned, {
      text: `higher-timeframe bias is ${trend.higherTimeframeBias}`,
      weight: 35,
      source: "trend.htf",
    });
  }

  // Nearest actionable level personality.
  const actionLevel = bias === "bullish" ? levels.nearestSupport : levels.nearestResistance;
  if (actionLevel) {
    const strong =
      actionLevel.personality === "defended" || actionLevel.personality === "fresh";
    supports(strong, {
      text: `nearest ${actionLevel.kind} at ${actionLevel.price} is ${actionLevel.personality}`,
      weight: round(clamp(actionLevel.strengthScore * 0.8 + 15)),
      source: "levels",
    });
    if (actionLevel.personality === "trap_zone") {
      contradictions.push({
        text: `Trading ${bias} into a trap-zone ${actionLevel.kind}.`,
        severity: "high",
      });
    }
    if (actionLevel.weaknessScore >= 50) {
      contradictions.push({
        text: `Nearest ${actionLevel.kind} is weakening (weakness ${actionLevel.weaknessScore}).`,
        severity: "medium",
      });
    }
  }

  // The opposing barrier (resistance for longs, support for shorts).
  const barrier = bias === "bullish" ? levels.nearestResistance : levels.nearestSupport;
  if (barrier && barrier.personality === "defended") {
    evidenceAgainst.push({
      text: `defended ${barrier.kind} overhead at ${barrier.price}`,
      weight: round(clamp(barrier.strengthScore * 0.7)),
      source: "levels.barrier",
    });
  }

  // Candle intent.
  if (candleIntent.populated) {
    const pressureAligned =
      (bias === "bullish" && candleIntent.dominantPressure === "buyers") ||
      (bias === "bearish" && candleIntent.dominantPressure === "sellers");
    supports(pressureAligned, {
      text: `recent candles show ${candleIntent.dominantPressure} pressure (${candleIntent.latestIntent})`,
      weight: 40,
      source: "candleIntent",
    });
    if (candleIntent.latestIntent === "trapping" || candleIntent.latestIntent === "exhausting") {
      contradictions.push({
        text: `latest bar reads "${candleIntent.latestIntent}" against a ${bias} idea.`,
        severity: "medium",
      });
    }
  }

  // Timeframe agreement.
  if (tfAgreement.populated && tfAgreement.agreementScore != null) {
    const tfAligned = tfAgreement.alignedDirection === bias;
    supports(tfAligned && tfAgreement.agreementScore >= 50, {
      text: `timeframe agreement ${tfAgreement.agreementScore} (${tfAgreement.alignedDirection})`,
      weight: round(clamp(tfAgreement.agreementScore * 0.7)),
      source: "timeframeAgreement",
    });
    if (tfAgreement.scalpOnlyWarning) {
      contradictions.push({
        text: "Lower and higher timeframes conflict — scalp-only, do not hold.",
        severity: "high",
      });
    }
  }

  // Setup stage as soft evidence.
  if (setup.stage === "invalid" || setup.stage === "stale") {
    contradictions.push({
      text: `Setup stage is ${setup.stage}.`,
      severity: setup.stage === "invalid" ? "high" : "medium",
    });
  }

  const forWeight = evidenceFor.reduce((a, e) => a + e.weight, 0);
  const againstWeight = evidenceAgainst.reduce((a, e) => a + e.weight, 0);
  let direction: ChartEvidenceDirection;
  if (forWeight === 0 && againstWeight === 0) direction = "neutral";
  else if (forWeight >= againstWeight * 1.2) direction = bias;
  else if (againstWeight >= forWeight * 1.2)
    direction = bias === "bullish" ? "bearish" : "bullish";
  else direction = "neutral";

  return {
    populated: true,
    direction,
    evidenceFor: evidenceFor.sort((a, b) => b.weight - a.weight),
    evidenceAgainst: evidenceAgainst.sort((a, b) => b.weight - a.weight),
    contradictions,
    note: `${evidenceFor.length} for / ${evidenceAgainst.length} against, ${contradictions.length} contradiction(s).`,
  };
}
