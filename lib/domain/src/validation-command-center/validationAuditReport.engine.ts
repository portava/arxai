// ═══════════════════════════════════════════════════════════════════════════
// Validation Audit Report — pure. Produces a vault-ready audit document
// summarising the entire Validation Command Center decision: every score,
// every restriction, every check verdict, plus a plain-English explanation.
//
// The Black Box Vault stores one of these per decision so reviewers and
// regulators have a permanent, replayable record of why a candidate was
// promoted, demoted, frozen, restricted, or retired.
// ═══════════════════════════════════════════════════════════════════════════

import type { ValidationStage } from "../validation-pipeline/validation.types";
import type { CommandCenterResult } from "./validationCommandCenter.engine";
import type { ScorecardResult } from "./validationScorecard.engine";
import type { MonteCarloResult } from "./monteCarloValidator.engine";
import type { OutOfSampleResult } from "./outOfSampleValidator.engine";
import type { EdgeDurabilityResult } from "./edgeDurability.engine";
import type { RegimeFitResult } from "./regimeSpecificValidator.engine";
import type { ExecutionRealityResult } from "./executionRealityValidator.engine";
import type { TraderBehaviorResult } from "./traderBehaviorValidator.engine";
import type { StatisticalSignificanceResult } from "./statisticalSignificance.engine";
import type { StressResult } from "./stressValidation.engine";

export interface AuditReportInput {
  candidateId: string;
  asOfIso: string;
  command: CommandCenterResult;
  scorecard: ScorecardResult;
  monteCarlo?: MonteCarloResult;
  outOfSample?: OutOfSampleResult;
  edgeDurability?: EdgeDurabilityResult;
  regimeFit?: RegimeFitResult;
  executionReality?: ExecutionRealityResult;
  traderBehavior?: TraderBehaviorResult;
  statisticalSignificance?: StatisticalSignificanceResult;
  stress?: StressResult;
}

export type AuditTimelineVerdict = "PASS" | "WARN" | "FAIL";
export interface AuditTimelineEntry {
  check: string;
  verdict: AuditTimelineVerdict;
  detail: string;
  score01?: number;
}

export interface ValidationAuditReport {
  candidateId: string;
  asOfIso: string;
  currentStage: ValidationStage;
  recommendedStage: ValidationStage;
  decision: CommandCenterResult["decision"];
  scoreSummary: Record<string, number>;
  scorecardDimensions: ScorecardResult["dimensions"];
  restrictions: string[];
  blockers: string[];
  timeline: AuditTimelineEntry[];
  plainEnglishExplanation: string;
}

function verdict(score01: number, passThr = 0.6, warnThr = 0.4): AuditTimelineVerdict {
  if (score01 >= passThr) return "PASS";
  if (score01 >= warnThr) return "WARN";
  return "FAIL";
}

export function buildValidationAuditReport(i: AuditReportInput): ValidationAuditReport {
  const tl: AuditTimelineEntry[] = [];

  if (i.statisticalSignificance) {
    const s = i.statisticalSignificance;
    tl.push({
      check: "STATISTICAL_SIGNIFICANCE", verdict: verdict(s.score01),
      score01: s.score01,
      detail: `expectancy ${s.expectancyR.toFixed(3)}R, p≈${s.pValueOneSided01.toFixed(3)}, ` +
              `CI95 [${s.confidenceLow95R.toFixed(3)}, ${s.confidenceHigh95R.toFixed(3)}]`,
    });
  }
  if (i.outOfSample) {
    const o = i.outOfSample;
    tl.push({
      check: "OUT_OF_SAMPLE", verdict: o.oosPassing ? "PASS" : "FAIL",
      score01: o.score01,
      detail: `OOS/IS ratio ${o.ratio.toFixed(2)}, overfit≈${(o.overfittingProbability01 * 100).toFixed(0)}%`,
    });
  }
  if (i.monteCarlo) {
    const m = i.monteCarlo;
    tl.push({
      check: "MONTE_CARLO_STRESS", verdict: verdict(m.score01),
      score01: m.score01,
      detail: `${m.simulations} sims, ruin ${(m.ruinProbability01 * 100).toFixed(1)}%, ` +
              `p05 ${m.p05FinalR.toFixed(2)}R, worstDD ${m.worstDrawdownR.toFixed(2)}R`,
    });
  }
  if (i.regimeFit) {
    const r = i.regimeFit;
    tl.push({
      check: "REGIME_FIT", verdict: r.label === "BROAD" ? "PASS"
                          : r.label === "INSUFFICIENT_DATA" ? "WARN"
                          : r.regimesPassing.length > 0 ? "WARN" : "FAIL",
      score01: r.score01,
      detail: `${r.regimesPassing.length}/${r.regimesEvaluated.length} regimes passing → ${r.label}`,
    });
  }
  if (i.executionReality) {
    const e = i.executionReality;
    tl.push({
      check: "EXECUTION_REALITY", verdict: e.netExpectancyR > 0 ? verdict(e.score01) : "FAIL",
      score01: e.score01,
      detail: `net ${e.netExpectancyR.toFixed(3)}R after exec, shortfall ${(e.shortfallPctOfExpectancy01 * 100).toFixed(1)}%, ` +
              `fill ${e.fillProbability01.toFixed(2)}, broker ${e.brokerReliability01.toFixed(2)}`,
    });
  }
  if (i.traderBehavior) {
    const t = i.traderBehavior;
    tl.push({
      check: "TRADER_BEHAVIOR_SAFETY", verdict: verdict(t.score01),
      score01: t.score01,
      detail: `after-loss deg ${(t.afterLossDegradationPct01 * 100).toFixed(1)}%, ` +
              `after-override deg ${(t.afterOverrideDegradationPct01 * 100).toFixed(1)}%`,
    });
  }
  if (i.edgeDurability) {
    const d = i.edgeDurability;
    tl.push({
      check: "EDGE_DURABILITY",
      verdict: d.decayLevel === "STABLE" ? "PASS"
             : d.decayLevel === "MILD"   ? "WARN"
             : "FAIL",
      score01: d.score01,
      detail: `decay ${d.decayLevel} (${(d.decayPct01 * 100).toFixed(0)}%), expectancy gap ${(d.expectancyGapPct01 * 100).toFixed(0)}%`,
    });
  }
  if (i.stress) {
    const s = i.stress;
    tl.push({
      check: "STRESS_SCENARIOS", verdict: verdict(s.score01),
      score01: s.score01,
      detail: `${s.scenariosPassed.length}/${s.scenarios.length} survived; worst "${s.worstScenarioKind}" lost ${(s.worstDegradationPct01 * 100).toFixed(0)}%`,
    });
  }
  // Always append the scorecard summary as the closing entry.
  tl.push({
    check: "SCORECARD_OVERALL",
    verdict: i.scorecard.passed ? "PASS"
           : i.scorecard.failingDimensions.length === i.scorecard.dimensionsTotal ? "FAIL" : "WARN",
    score01: i.scorecard.overallScore01,
    detail: `${i.scorecard.dimensionsPassed}/${i.scorecard.dimensionsTotal} dimensions passing; ` +
            `weakest = ${i.scorecard.weakestDimension}`,
  });

  return {
    candidateId: i.candidateId,
    asOfIso: i.asOfIso,
    currentStage: i.command.currentStage,
    recommendedStage: i.command.recommendedStage,
    decision: i.command.decision,
    scoreSummary: {
      liveReadiness:           i.command.liveReadinessScore01,
      edgeDurability:          i.command.edgeDurabilityScore01,
      survival:                i.command.survivalScore01,
      executionReality:        i.command.executionRealityScore01,
      statisticalConfidence:   i.command.statisticalConfidenceScore01,
      regimeFit:               i.command.regimeFitScore01,
      traderBehaviorSafety:    i.command.traderBehaviorSafetyScore01,
      overfittingRisk:         i.command.overfittingRiskScore01,
      scorecard:               i.command.scorecardScore01,
    },
    scorecardDimensions: i.scorecard.dimensions,
    restrictions: i.command.restrictions,
    blockers: i.command.blockers,
    timeline: tl,
    plainEnglishExplanation: i.command.plainEnglishExplanation,
  };
}
