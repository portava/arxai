import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";

// Trader behavior — composes the trader-dna engine outputs into a single
// score. Hard blockers when the operator is in a clearly impaired state.

export function scoreTraderBehavior(ctx: ConfidenceGateContext): ScoreReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];

  const { revenge, overtrade, patterns } = ctx.trader;
  let score = 100;

  // Revenge trading
  if (revenge?.detected) {
    if (revenge.severity === "CRITICAL") {
      blockers.push({ severity: "BEHAVIOR", dimension: "traderBehavior",
        message: `Revenge trading CRITICAL (${revenge.evidence.join("; ")})` });
      score -= 60;
    } else if (revenge.severity === "HIGH") {
      blockers.push({ severity: "BEHAVIOR", dimension: "traderBehavior",
        message: `Revenge trading HIGH` });
      score -= 40;
    } else {
      warnings.push(`Revenge signature at ${revenge.severity}`);
      score -= 20;
    }
    reasons.push(...revenge.evidence.map((e) => `revenge: ${e}`));
  }

  // Overtrading
  if (overtrade?.detected) {
    if (overtrade.recommendBlock) {
      blockers.push({ severity: "BEHAVIOR", dimension: "traderBehavior",
        message: `Overtrading (${overtrade.severity}) — ${overtrade.tradesToday} vs baseline ${overtrade.baseline.toFixed(1)}` });
      score -= 35;
    } else {
      warnings.push(`Overtrading at ${overtrade.severity}`);
      score -= 15;
    }
    reasons.push(...overtrade.evidence);
  }

  // Behavior patterns
  for (const hit of patterns.hits) {
    if (hit.severity === "CRITICAL") {
      blockers.push({ severity: "BEHAVIOR", dimension: "traderBehavior",
        message: `Critical pattern: ${hit.pattern}` });
      score -= 30;
    } else if (hit.severity === "HIGH") {
      score -= 15;
      warnings.push(`${hit.pattern} at HIGH severity`);
    } else if (hit.severity === "MEDIUM") {
      score -= 7;
    }
    reasons.push(`pattern ${hit.pattern} (${hit.severity}, ${hit.confidence}%)`);
  }

  // Cooldown still active?
  if (revenge?.cooldownUntil) {
    const cd = new Date(revenge.cooldownUntil).getTime();
    const now = (ctx.now ?? new Date()).getTime();
    if (cd > now) {
      blockers.push({ severity: "BEHAVIOR", dimension: "traderBehavior",
        message: `Trader cooldown active until ${revenge.cooldownUntil}` });
    }
  }

  if (!revenge?.detected && !overtrade?.detected && patterns.hits.length === 0) {
    reasons.push("No behavior red flags");
  }

  return {
    dimension: "traderBehavior",
    score: Math.max(0, Math.min(100, Math.round(score))),
    weight: SCORE_WEIGHTS.traderBehavior,
    blockers, warnings, reasons,
    evidence: {
      revengeDetected: !!revenge?.detected, revengeSeverity: revenge?.severity,
      overtradeDetected: !!overtrade?.detected, overtradeSeverity: overtrade?.severity,
      patternHits: patterns.hits.map((h) => ({ pattern: h.pattern, severity: h.severity })),
    },
  };
}
