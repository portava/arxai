import { z } from "zod/v4";
import {
  type CandidateState, type StageValidationResult, type LiveReadinessScore,
  type DemotionCheck, type ValidationStage,
  CandidateStateSchema, StageValidationResultSchema, LiveReadinessScoreSchema,
  DemotionCheckSchema, ValidationStageSchema, STAGE_ORDER, stageRank, isLiveStage,
} from "./validation.types";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Report — pure aggregator. Combines a candidate's state, the
// per-stage history of validation results, the latest readiness score, and
// any latest demotion check into one explainable, vault-loggable document.
//
// The recommendation is derived deterministically:
//   • RETIRE  — frozen + readiness blockers OR severe demotion proposing RESEARCH
//   • FREEZE  — frozen by Risk Governor (any reason)
//   • DEMOTE  — latest demotion check says shouldDemote
//   • PROMOTE — readiness.ready AND latest stage at currentStage = PASS
//   • HOLD    — anything else (default safe)
// ═══════════════════════════════════════════════════════════════════════════

export const ValidationRecommendationSchema = z.enum([
  "PROMOTE", "HOLD", "DEMOTE", "FREEZE", "RETIRE",
]);
export type ValidationRecommendation = z.infer<typeof ValidationRecommendationSchema>;

export const ValidationReportSchema = z.object({
  candidateId: z.string().min(1),
  generatedAtIso: z.string(),
  currentStage: ValidationStageSchema,
  frozen: z.boolean(),
  recommendation: ValidationRecommendationSchema,
  readiness: LiveReadinessScoreSchema,
  perStage: z.record(ValidationStageSchema, z.object({
    latestVerdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE", "FROZEN", "ABSENT"]),
    failedChecks: z.array(z.string()),
    recordedAtIso: z.string().nullable(),
    sampleSize: z.int().nonnegative().nullable(),
  })),
  latestDemotionCheck: DemotionCheckSchema.nullable(),
  transitions: z.array(z.object({
    fromStage: ValidationStageSchema,
    toStage: ValidationStageSchema,
    transitionKind: z.enum(["PROMOTE", "DEMOTE", "FREEZE", "RESET", "INIT"]),
    triggeredBy: z.enum(["VALIDATOR", "RISK_GOVERNOR", "CONTROL_TOWER",
                          "EDGE_DECAY", "MANUAL", "OTHER"]),
    atIso: z.string(),
    reason: z.string(),
  })),
  blockers: z.array(z.string()),
  reasons: z.array(z.string()),
  // For Black Box Vault payload field
  summary: z.string(),
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

export interface ValidationReportInput {
  state: CandidateState;
  stageResults: ReadonlyArray<StageValidationResult>;
  readiness: LiveReadinessScore;
  latestDemotionCheck?: DemotionCheck | null;
  generatedAtIso: string;
}

export function buildValidationReport(input: ValidationReportInput): ValidationReport {
  const { state, stageResults, readiness, generatedAtIso } = input;
  const latestDemotionCheck = input.latestDemotionCheck ?? null;
  const blockers: string[] = [...readiness.blockers];
  const reasons: string[] = [];

  // Latest result per stage (chronological — last wins).
  const latestByStage = new Map<ValidationStage, StageValidationResult>();
  const sorted = [...stageResults].sort((a, b) =>
    a.recordedAtIso < b.recordedAtIso ? -1 : 1);
  for (const r of sorted) latestByStage.set(r.stage, r);

  const perStage: ValidationReport["perStage"] = {} as ValidationReport["perStage"];
  for (const stage of STAGE_ORDER) {
    if (stage === "RESEARCH") continue;
    const r = latestByStage.get(stage);
    perStage[stage] = r
      ? {
          latestVerdict: r.verdict,
          failedChecks: r.failedChecks,
          recordedAtIso: r.recordedAtIso,
          sampleSize: r.metrics.trades,
        }
      : { latestVerdict: "ABSENT", failedChecks: [], recordedAtIso: null, sampleSize: null };
  }

  // Recommendation logic — order matters; first match wins.
  let recommendation: ValidationRecommendation = "HOLD";
  const currentLatest = latestByStage.get(state.currentStage);
  const severeDemotion = latestDemotionCheck?.shouldDemote
    && latestDemotionCheck.proposedStage === "RESEARCH";

  if (state.frozen && (severeDemotion || readiness.blockers.length > 0)) {
    recommendation = "RETIRE";
    reasons.push(`RETIRE: frozen with severe demotion or readiness blockers`);
  } else if (state.frozen) {
    recommendation = "FREEZE";
    reasons.push(`FREEZE: candidate frozen by Risk Governor`);
  } else if (latestDemotionCheck?.shouldDemote) {
    recommendation = "DEMOTE";
    reasons.push(`DEMOTE: ${latestDemotionCheck.triggers.join(",")} → ${latestDemotionCheck.proposedStage}`);
  } else if (readiness.ready
             && currentLatest?.verdict === "PASS"
             && stageRank(state.currentStage) < STAGE_ORDER.length - 1) {
    recommendation = "PROMOTE";
    reasons.push(`PROMOTE: readiness ${readiness.score01.toFixed(2)} ≥ threshold and current stage PASS`);
  } else {
    reasons.push(`HOLD: no promote/demote/freeze conditions met`);
    if (!currentLatest) reasons.push(`HOLD reason: no result on current stage ${state.currentStage}`);
    else if (currentLatest.verdict !== "PASS") reasons.push(`HOLD reason: current stage verdict is ${currentLatest.verdict}`);
    if (!readiness.ready) reasons.push(`HOLD reason: readiness.ready=false`);
  }

  // Pull pipeline-level reasons through so they're vault-visible.
  reasons.push(...readiness.reasons.map(r => `readiness: ${r}`));

  const summary = [
    `candidate=${state.candidate.candidateId}`,
    `kind=${state.candidate.kind}`,
    `stage=${state.currentStage}${isLiveStage(state.currentStage) ? "(LIVE)" : ""}`,
    `frozen=${state.frozen}`,
    `readiness=${readiness.score01.toFixed(2)}`,
    `recommendation=${recommendation}`,
  ].join(" ");

  return {
    candidateId: state.candidate.candidateId,
    generatedAtIso,
    currentStage: state.currentStage,
    frozen: state.frozen,
    recommendation,
    readiness,
    perStage,
    latestDemotionCheck,
    transitions: state.history,
    blockers,
    reasons,
    summary,
  };
}

// Re-export schemas the outer route layer wants for body validation.
export const ValidationReportInputBodySchema = z.object({
  state: CandidateStateSchema,
  stageResults: z.array(StageValidationResultSchema),
  readiness: LiveReadinessScoreSchema,
  latestDemotionCheck: DemotionCheckSchema.nullable().optional(),
  generatedAtIso: z.string(),
});
export type ValidationReportInputBody = z.infer<typeof ValidationReportInputBodySchema>;
