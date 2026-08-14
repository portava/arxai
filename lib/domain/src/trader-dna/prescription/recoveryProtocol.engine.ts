// ═══════════════════════════════════════════════════════════════════════════
// Recovery Protocol
//
// Defines exactly what restores permissions after a prescription has been
// applied. Output is twofold:
//
//   • recoveryRequirements          — what the trader must do
//   • permissionRestoreConditions   — checkable conditions the system
//                                     evaluates against current state
//
// `evaluateRecovery()` checks the current observation against the required
// conditions and returns whether restoration is permitted, plus a concrete
// list of remaining gates.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const RecoveryConditionKindSchema = z.enum([
  "TIME_COOLDOWN",
  "DISCIPLINE_SCORE",
  "NO_RULE_VIOLATIONS",
  "PAPER_TRADE_WINS",
  "COGNITIVE_RISK_BELOW",
  "BEHAVIOR_EVIDENCE_BELOW",
  "BASELINE_MATURE",
]);
export type RecoveryConditionKind = z.infer<typeof RecoveryConditionKindSchema>;

export const RecoveryConditionSchema = z.object({
  kind: RecoveryConditionKindSchema,
  description: z.string(),
  threshold: z.number(),
});
export type RecoveryCondition = z.infer<typeof RecoveryConditionSchema>;

export const RecoveryProtocolSchema = z.object({
  recoveryRequirements: z.array(z.string()),
  permissionRestoreConditions: z.array(RecoveryConditionSchema),
});
export type RecoveryProtocol = z.infer<typeof RecoveryProtocolSchema>;

export interface RecoveryProtocolInput {
  severity01: number;
  baselineMature: boolean;
  paperModeForced: boolean;
  requiredPaperWins: number;
  minPaperWinRate: number;
  cooldownMinutes: number;
}

export function buildRecoveryProtocol(input: RecoveryProtocolInput): RecoveryProtocol {
  const conditions: RecoveryCondition[] = [];
  const requirements: string[] = [];

  if (input.cooldownMinutes > 0) {
    conditions.push({
      kind: "TIME_COOLDOWN",
      description: `Wait at least ${input.cooldownMinutes} minutes since last cooldown event`,
      threshold: input.cooldownMinutes,
    });
    requirements.push(`Step away from charts for ${input.cooldownMinutes} minutes`);
  }

  // Discipline + rule adherence apply at any meaningful severity.
  if (input.severity01 >= 0.25) {
    conditions.push({ kind: "DISCIPLINE_SCORE", description: "Discipline score must be ≥ 0.65", threshold: 0.65 });
    conditions.push({ kind: "NO_RULE_VIOLATIONS", description: "Zero rule violations in the last 24h", threshold: 0 });
    requirements.push("Maintain discipline (score ≥ 0.65) with zero rule violations in the next 24h");
  }

  if (input.severity01 >= 0.50) {
    conditions.push({ kind: "BEHAVIOR_EVIDENCE_BELOW", description: "Behavior evidence score must drop below 0.40", threshold: 0.40 });
    conditions.push({ kind: "COGNITIVE_RISK_BELOW",    description: "Cognitive risk score must drop below 0.40",    threshold: 0.40 });
    requirements.push("Behavior + cognitive evidence must drop below 0.40");
  }

  if (input.paperModeForced && input.requiredPaperWins > 0) {
    conditions.push({
      kind: "PAPER_TRADE_WINS",
      description: `Complete ${input.requiredPaperWins} profitable paper trades at ≥${(input.minPaperWinRate*100).toFixed(0)}% win rate`,
      threshold: input.requiredPaperWins,
    });
    requirements.push(`Execute ${input.requiredPaperWins} winning paper trades (≥${(input.minPaperWinRate*100).toFixed(0)}% WR)`);
  }

  if (!input.baselineMature) {
    conditions.push({ kind: "BASELINE_MATURE", description: "Personal baseline must reach maturity (≥30 trades, ≥10 days)", threshold: 30 });
    requirements.push("Continue building personal baseline (≥30 trades over ≥10 days)");
  }

  return { recoveryRequirements: requirements, permissionRestoreConditions: conditions };
}

// ── Recovery evaluation ────────────────────────────────────────────────────
export const RecoveryObservationSchema = z.object({
  minutesSinceLastCooldown: z.number().nonnegative().optional(),
  disciplineScore01: z.number().min(0).max(1).optional(),
  ruleViolationsLast24h: z.number().int().nonnegative().optional(),
  paperTradeWins: z.number().int().nonnegative().optional(),
  paperTradeSample: z.number().int().nonnegative().optional(),
  cognitiveRiskScore01: z.number().min(0).max(1).optional(),
  behaviorEvidenceScore01: z.number().min(0).max(1).optional(),
  baselineMature: z.boolean().optional(),
}).strict();
export type RecoveryObservation = z.infer<typeof RecoveryObservationSchema>;

export const RecoveryEvaluationSchema = z.object({
  canRestore: z.boolean(),
  satisfied: z.array(RecoveryConditionSchema),
  pending: z.array(RecoveryConditionSchema.extend({ remaining: z.string() })),
  reasons: z.array(z.string()),
});
export type RecoveryEvaluation = z.infer<typeof RecoveryEvaluationSchema>;

export function evaluateRecovery(
  protocol: RecoveryProtocol,
  obs: RecoveryObservation,
  paperMode: { requiredPaperWins: number; minPaperWinRate: number },
): RecoveryEvaluation {
  const satisfied: RecoveryCondition[] = [];
  const pending: (RecoveryCondition & { remaining: string })[] = [];
  const reasons: string[] = [];

  for (const c of protocol.permissionRestoreConditions) {
    let ok = false;
    let remaining = c.description;
    switch (c.kind) {
      case "TIME_COOLDOWN":
        ok = (obs.minutesSinceLastCooldown ?? 0) >= c.threshold;
        if (!ok) remaining = `wait ${(c.threshold - (obs.minutesSinceLastCooldown ?? 0)).toFixed(0)} more minutes`;
        break;
      case "DISCIPLINE_SCORE":
        ok = (obs.disciplineScore01 ?? 0) >= c.threshold;
        if (!ok) remaining = `discipline ${(obs.disciplineScore01 ?? 0).toFixed(2)} < ${c.threshold}`;
        break;
      case "NO_RULE_VIOLATIONS":
        ok = (obs.ruleViolationsLast24h ?? 0) <= c.threshold;
        if (!ok) remaining = `${obs.ruleViolationsLast24h} rule violation(s) in last 24h`;
        break;
      case "PAPER_TRADE_WINS": {
        const wins = obs.paperTradeWins ?? 0;
        const sample = obs.paperTradeSample ?? 0;
        const wr = sample > 0 ? wins / sample : 0;
        ok = wins >= c.threshold && wr >= paperMode.minPaperWinRate;
        if (!ok) remaining = `${wins}/${c.threshold} paper wins · WR ${(wr*100).toFixed(0)}%`;
        break;
      }
      case "COGNITIVE_RISK_BELOW":
        ok = (obs.cognitiveRiskScore01 ?? 1) < c.threshold;
        if (!ok) remaining = `cognitive risk ${(obs.cognitiveRiskScore01 ?? 1).toFixed(2)} ≥ ${c.threshold}`;
        break;
      case "BEHAVIOR_EVIDENCE_BELOW":
        ok = (obs.behaviorEvidenceScore01 ?? 1) < c.threshold;
        if (!ok) remaining = `behavior evidence ${(obs.behaviorEvidenceScore01 ?? 1).toFixed(2)} ≥ ${c.threshold}`;
        break;
      case "BASELINE_MATURE":
        ok = !!obs.baselineMature;
        if (!ok) remaining = `baseline still building`;
        break;
    }
    if (ok) satisfied.push(c);
    else    pending.push({ ...c, remaining });
  }

  const canRestore = pending.length === 0 && protocol.permissionRestoreConditions.length > 0;
  reasons.push(`${satisfied.length}/${protocol.permissionRestoreConditions.length} conditions satisfied`);
  if (!canRestore && pending.length > 0) reasons.push(`pending: ${pending.map(p => p.remaining).join("; ")}`);

  return { canRestore, satisfied, pending, reasons };
}
