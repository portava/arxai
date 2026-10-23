// ═══════════════════════════════════════════════════════════════════════════
// Behavior Evidence
//
// Central evidence ledger for the Behavior Risk Intelligence System.
// Composes observable signals into a uniform list of `BehaviorEvidenceItem`
// objects + a single `behaviorEvidenceScore01` (higher = more risk
// evidence). Never labels the trader emotionally.
//
// Sources of evidence (only what the system observes):
//   • behavior pattern hits (overtrading, oversize, runner-cutting, etc.)
//   • revenge trading detector
//   • overtrade guard
//   • post-loss behavior deviation
//   • override forensics (rule violations, post-loss overrides)
//   • personal drawdown profile (depth/duration vs history)
//   • baseline-deviation flags (frequency, sizing, hold time)
//   • late-session activity flag
//
// Pure. The score is intentionally bounded by the worst single piece of
// evidence to prevent dilution.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { BehaviorPatternHit } from "./behaviorPattern.engine";
import type { RevengeTradeReport } from "./revengeTradingDetector.engine";
import type { OvertradeReport } from "./overtradeGuard.engine";
import type { PostLossProfile } from "./postLossBehavior.engine";
import type { OverrideForensicsReport } from "./overrideForensics.engine";
import type { PersonalDrawdownProfile } from "./personalDrawdownProfile.engine";
import type { PersonalBaseline } from "./personalBaseline.engine";
import { DnaSeveritySchema, type DnaSeverity } from "./traderProfile.types";

export const BehaviorEvidenceKindSchema = z.enum([
  "BEHAVIOR_PATTERN",
  "REVENGE",
  "OVERTRADE",
  "POST_LOSS_DEVIATION",
  "OVERRIDE_RULE_VIOLATION",
  "OVERRIDE_RISK_INCREASE",
  "DRAWDOWN_PRESSURE",
  "FREQUENCY_DEVIATION",
  "SIZING_DEVIATION",
  "HOLD_TIME_DEVIATION",
  "LATE_SESSION_ACTIVITY",
  "BASELINE_IMMATURE",
]);
export type BehaviorEvidenceKind = z.infer<typeof BehaviorEvidenceKindSchema>;

export const BehaviorEvidenceItemSchema = z.object({
  kind: BehaviorEvidenceKindSchema,
  severity: DnaSeveritySchema,
  evidence: z.array(z.string()),
  deltaVsBaseline: z.number().nullable(),   // ratio or pp where applicable
  neutralLanguage: z.string(),              // never shames trader
});
export type BehaviorEvidenceItem = z.infer<typeof BehaviorEvidenceItemSchema>;

export const BehaviorEvidenceReportSchema = z.object({
  items: z.array(BehaviorEvidenceItemSchema),
  behaviorEvidenceScore01: z.number().min(0).max(1),
  worstSeverity: DnaSeveritySchema,
  hasMatureBaseline: z.boolean(),
  reasons: z.array(z.string()),
});
export type BehaviorEvidenceReport = z.infer<typeof BehaviorEvidenceReportSchema>;

const SEV_TO_01: Record<DnaSeverity, number> = {
  NONE: 0, LOW: 0.20, MEDIUM: 0.45, HIGH: 0.70, CRITICAL: 1.0,
};

export interface BehaviorEvidenceInput {
  baseline: PersonalBaseline;
  patterns?: BehaviorPatternHit[];
  revenge?: RevengeTradeReport | null;
  overtrade?: OvertradeReport | null;
  postLoss?: PostLossProfile | null;
  overrides?: OverrideForensicsReport | null;
  drawdown?: PersonalDrawdownProfile | null;
  // Direct observations the caller already computed
  currentTradesPerDay?: number;
  currentAvgLot?: number;
  currentAvgHoldMinutes?: number;
  lateSessionTradesLastDay?: number;     // trades opened after the trader's preferred window
}

export function composeBehaviorEvidence(input: BehaviorEvidenceInput): BehaviorEvidenceReport {
  const items: BehaviorEvidenceItem[] = [];
  const reasons: string[] = [];

  // Pattern hits
  for (const p of input.patterns ?? []) {
    if (p.severity === "NONE") continue;
    items.push({
      kind: "BEHAVIOR_PATTERN", severity: p.severity,
      evidence: p.evidence, deltaVsBaseline: null,
      neutralLanguage: `Observed pattern: ${p.pattern} (${p.severity}). Not a personality judgment — a frequency observation.`,
    });
  }

  // Revenge
  if (input.revenge?.detected) {
    items.push({
      kind: "REVENGE", severity: input.revenge.severity,
      evidence: input.revenge.evidence, deltaVsBaseline: null,
      neutralLanguage: `Pattern after a loss: re-entry within 30 minutes with size escalation. Elevated risk pattern detected.`,
    });
  }

  // Overtrade
  if (input.overtrade?.detected) {
    items.push({
      kind: "OVERTRADE", severity: input.overtrade.severity,
      evidence: input.overtrade.evidence,
      deltaVsBaseline: input.overtrade.ratio - 1,
      neutralLanguage: `Trade frequency ${input.overtrade.ratio.toFixed(2)}× normal. Above your personal baseline.`,
    });
  }

  // Post-loss deviation
  if (input.postLoss && input.postLoss.postLossSample > 0 && input.postLoss.postLossRiskScore01 >= 0.30) {
    items.push({
      kind: "POST_LOSS_DEVIATION",
      severity: scoreToSeverity(input.postLoss.postLossRiskScore01),
      evidence: input.postLoss.evidence,
      deltaVsBaseline: input.postLoss.postLossAvgLotMultiple - 1,
      neutralLanguage: `Post-loss behavior differs from baseline. Consider a brief reset before the next entry.`,
    });
  }

  // Override forensics
  if (input.overrides) {
    if (input.overrides.ruleViolatedCount > 0) {
      const sev: DnaSeverity = input.overrides.ruleViolatedCount >= 3 ? "HIGH"
                              : input.overrides.ruleViolatedCount >= 1 ? "MEDIUM" : "LOW";
      items.push({
        kind: "OVERRIDE_RULE_VIOLATION", severity: sev,
        evidence: [`${input.overrides.ruleViolatedCount} rule-violating override(s)`],
        deltaVsBaseline: null,
        neutralLanguage: `Manual overrides bypassed an active rule. Review whether the rule needs updating or the override needs review.`,
      });
    }
    if (input.overrides.increasedRiskCount > 0) {
      items.push({
        kind: "OVERRIDE_RISK_INCREASE",
        severity: input.overrides.increasedRiskCount >= 3 ? "HIGH" : "MEDIUM",
        evidence: [`${input.overrides.increasedRiskCount} override(s) increased position size beyond baseline`],
        deltaVsBaseline: null,
        neutralLanguage: `Some overrides increased risk size. Worth a review against your written plan.`,
      });
    }
  }

  // Drawdown pressure
  if (input.drawdown && input.drawdown.drawdownRiskScore01 >= 0.30) {
    items.push({
      kind: "DRAWDOWN_PRESSURE",
      severity: scoreToSeverity(input.drawdown.drawdownRiskScore01),
      evidence: input.drawdown.reasons,
      deltaVsBaseline: null,
      neutralLanguage: `Currently in a drawdown comparable to past episodes. Conservative sizing recommended until equity peak is recovered.`,
    });
  }

  // Frequency / sizing / hold time deviations vs baseline (only if mature)
  if (input.baseline.isMature) {
    if (input.currentTradesPerDay !== undefined && input.baseline.tradesPerDay > 0) {
      const r = input.currentTradesPerDay / input.baseline.tradesPerDay;
      if (r >= 1.5) items.push(deviationItem("FREQUENCY_DEVIATION", r,
        `current ${input.currentTradesPerDay.toFixed(1)} vs baseline ${input.baseline.tradesPerDay.toFixed(1)} trades/day`,
        `Trade frequency ${r.toFixed(2)}× your personal baseline.`));
    }
    if (input.currentAvgLot !== undefined && input.baseline.lotSize.median > 0) {
      const r = input.currentAvgLot / input.baseline.lotSize.median;
      if (r >= 1.5) items.push(deviationItem("SIZING_DEVIATION", r,
        `current avg lot ${input.currentAvgLot.toFixed(2)} vs baseline median ${input.baseline.lotSize.median.toFixed(2)}`,
        `Average position size ${r.toFixed(2)}× your normal.`));
    }
    if (input.currentAvgHoldMinutes !== undefined && input.baseline.holdMinutes.median > 0) {
      const r = input.currentAvgHoldMinutes / input.baseline.holdMinutes.median;
      if (r <= 0.5) items.push(deviationItem("HOLD_TIME_DEVIATION", r - 1,
        `current avg hold ${input.currentAvgHoldMinutes.toFixed(1)}m vs baseline median ${input.baseline.holdMinutes.median.toFixed(1)}m`,
        `Hold times ~${(r*100).toFixed(0)}% of baseline. Trades closing earlier than usual.`));
    }
    if ((input.lateSessionTradesLastDay ?? 0) >= 3) {
      items.push({
        kind: "LATE_SESSION_ACTIVITY", severity: "MEDIUM",
        evidence: [`${input.lateSessionTradesLastDay} late-session entries vs typical pattern`],
        deltaVsBaseline: null,
        neutralLanguage: `Activity outside your usual session window. Often a fatigue indicator — observation, not judgment.`,
      });
    }
  } else {
    // Baseline not mature — keep judgments soft.
    items.push({
      kind: "BASELINE_IMMATURE", severity: "LOW",
      evidence: input.baseline.maturityReasons,
      deltaVsBaseline: null,
      neutralLanguage: `Personal baseline still building. Strong behavior judgments paused — keep recording trades.`,
    });
    reasons.push("baseline immature — score capped, no strong judgments");
  }

  // Score: weighted blend AND max-aware floor (worst single item floors the score).
  const weightedSum = items.reduce((s, it) => s + SEV_TO_01[it.severity], 0);
  const weightedMean = items.length ? weightedSum / items.length : 0;
  const worstScore = items.length
    ? items.map(it => SEV_TO_01[it.severity]).reduce((a, b) => Math.max(a, b), 0)
    : 0;
  let score = Math.max(weightedMean, 0.85 * worstScore);
  if (!input.baseline.isMature) score = Math.min(score, 0.50); // immaturity cap
  const behaviorEvidenceScore01 = clamp01(score);

  const worstSeverity: DnaSeverity = items.length
    ? items.map(it => it.severity).sort((a, b) => SEV_TO_01[b] - SEV_TO_01[a])[0]
    : "NONE";

  reasons.push(`composed ${items.length} evidence item(s) → score ${behaviorEvidenceScore01.toFixed(2)} (${worstSeverity} worst)`);

  return {
    items,
    behaviorEvidenceScore01,
    worstSeverity,
    hasMatureBaseline: input.baseline.isMature,
    reasons,
  };
}

function deviationItem(
  kind: "FREQUENCY_DEVIATION"|"SIZING_DEVIATION"|"HOLD_TIME_DEVIATION",
  delta: number,
  evidence: string,
  language: string,
): BehaviorEvidenceItem {
  const m = Math.abs(delta);
  const severity: DnaSeverity = m >= 1.5 ? "HIGH" : m >= 0.75 ? "MEDIUM" : "LOW";
  return { kind, severity, evidence: [evidence], deltaVsBaseline: delta, neutralLanguage: language };
}
function scoreToSeverity(s: number): DnaSeverity {
  if (s >= 0.85) return "CRITICAL";
  if (s >= 0.65) return "HIGH";
  if (s >= 0.45) return "MEDIUM";
  if (s >= 0.20) return "LOW";
  return "NONE";
}
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
