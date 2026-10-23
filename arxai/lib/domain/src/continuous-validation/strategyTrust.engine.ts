// ═══════════════════════════════════════════════════════════════════════════
// Strategy Trust — pure. Dynamic trust score updated from recent behavior
// and robustness. Trust changes are bounded to prevent jumpy reactions.
//
// Inputs:
//   • priorTrust01            — last trust value (0..1)
//   • recentExpectancyR       — recent live expectancy
//   • baselineExpectancyR     — pre-live baseline expectancy
//   • recentDrawdownR         — recent drawdown (positive number, R-units)
//   • drawdownLimitR          — risk governor's drawdown ceiling
//   • robustnessScore01       — adversarial robustness (0..1)
//   • recentOverrideRate01    — % of trades manually overridden recently
//   • recentSanityFailures    — # of pre-trade sanity blocks recently
//   • confidenceHealthScore01 — confidence health score from sibling engine
//
// Output:
//   • trustScore01, trustChange, trustGrade (A..F), reasons
//   • bounded change ±0.25 per call
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from "./confidenceHealth.engine";

export type TrustGrade = "A" | "B" | "C" | "D" | "F";

export interface StrategyTrustInput {
  candidateId: string;
  priorTrust01: number;
  recentExpectancyR: number;
  baselineExpectancyR: number;
  recentDrawdownR: number;
  drawdownLimitR: number;
  robustnessScore01: number;
  recentOverrideRate01: number;
  recentSanityFailures: number;
  confidenceHealthScore01: number;
  // Cap on per-call trust change; default 0.25.
  maxChangePerCall01?: number;
}
export interface StrategyTrustResult {
  candidateId: string;
  trustScore01: number;
  trustChange: number;
  trustGrade: TrustGrade;
  contributingFactors: Record<string, number>;
  reasons: string[];
}

function gradeOf(t: number): TrustGrade {
  if (t >= 0.85) return "A";
  if (t >= 0.70) return "B";
  if (t >= 0.55) return "C";
  if (t >= 0.40) return "D";
  return "F";
}

export function updateStrategyTrust(i: StrategyTrustInput): StrategyTrustResult {
  const reasons: string[] = [];
  const cap = Math.max(0.05, Math.min(1, i.maxChangePerCall01 ?? 0.25));

  // Performance delta: bounded relative to baseline
  const baseAbs = Math.max(0.01, Math.abs(i.baselineExpectancyR));
  const perfDelta = (i.recentExpectancyR - i.baselineExpectancyR) / baseAbs;
  const perfContribution = clampSym(perfDelta, 0.30) * 0.5;     // ±0.15

  // Robustness contribution: 0.7 is the neutral point
  const robContribution = (clamp01(i.robustnessScore01) - 0.7) * 0.30; // ±0.21

  // Confidence health contribution: 0.7 neutral
  const cnfContribution = (clamp01(i.confidenceHealthScore01) - 0.7) * 0.20; // ±0.14

  // Penalties
  const ddRatio = i.drawdownLimitR > 0 ? i.recentDrawdownR / i.drawdownLimitR : 0;
  const ddPenalty = ddRatio >= 0.95 ? -0.30
                  : ddRatio >= 0.80 ? -0.20
                  : ddRatio >= 0.60 ? -0.10
                  : 0;
  const sanityPenalty   = -Math.min(0.30, i.recentSanityFailures * 0.05);
  const overridePenalty = i.recentOverrideRate01 > 0.30 ? -0.10 : 0;

  let delta = perfContribution + robContribution + cnfContribution
            + ddPenalty + sanityPenalty + overridePenalty;
  // Cap per-call change
  delta = Math.max(-cap, Math.min(cap, delta));

  const newTrust = clamp01(clamp01(i.priorTrust01) + delta);
  const grade = gradeOf(newTrust);

  reasons.push(`Δtrust ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} → trust ${newTrust.toFixed(3)} (grade ${grade})`);
  reasons.push(`perf ${perfContribution.toFixed(3)} | robustness ${robContribution.toFixed(3)} | confidence ${cnfContribution.toFixed(3)}`);
  reasons.push(`penalties — drawdown ${ddPenalty.toFixed(3)}, sanity ${sanityPenalty.toFixed(3)}, override ${overridePenalty.toFixed(3)}`);

  return {
    candidateId: i.candidateId,
    trustScore01: newTrust,
    trustChange: delta,
    trustGrade: grade,
    contributingFactors: {
      performance: perfContribution,
      robustness: robContribution,
      confidence: cnfContribution,
      drawdownPenalty: ddPenalty,
      sanityPenalty,
      overridePenalty,
    },
    reasons,
  };
}

function clampSym(x: number, lim: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-lim, Math.min(lim, x));
}
