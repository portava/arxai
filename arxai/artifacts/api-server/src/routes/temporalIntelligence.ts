// ═══════════════════════════════════════════════════════════════════════════
// /api/trader-dna/temporal/*, /api/trader-dna/contextual/*,
// /api/trader-dna/recovery/*, /api/cognitive/adaptive/*,
// /api/trader-dna/long-horizon/* — Phase 5d.
//
// Strict, advisory only. canPlaceTrades:false on every response. Every
// computed report logged to the Black Box Vault. No live trade placement.
// Language is neutral.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { TradeSchema } from "@workspace/domain/trade";
import {
  buildPersonalBaseline,
  analyzeDecisionSequence,
  analyzePacing,
  detectEscalation,
  analyzeRecoveryTrajectory,
  composeContextualBehavior, ContextualBehaviorInputSchema,
  analyzeCooldownEffectiveness, CooldownRecordSchema,
  analyzeRestrictionEffectiveness, RestrictionRecordSchema,
  measureRecoveryEffectiveness, RecoveryEventKindSchema,
  detectBehavioralDrift,
  DailyDisciplinePointSchema,
  DailyAggressionPointSchema,
  DailyOverridePointSchema,
} from "@workspace/domain/trader-dna";
import {
  recommendAdaptivePacing,
  recommendNotificationIntensity,
  recommendUIDensity,
  recommendPermissionSensitivity,
} from "@workspace/domain/cognitive";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

const TraderIdSchema = z.string().min(1);

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/temporal/analyze
// ───────────────────────────────────────────────────────────────────────
const TemporalAnalyzeBody = z.object({
  id: TraderIdSchema,
  trades: z.array(TradeSchema),
  recoveryTriggerAt: z.string().datetime().optional(),
  recoveryWindowMinutes: z.number().positive().optional(),
}).strict();

router.post("/trader-dna/temporal/analyze", async (req: Request, res: Response) => {
  let body: z.infer<typeof TemporalAnalyzeBody>;
  try { body = TemporalAnalyzeBody.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const baseline = buildPersonalBaseline(body.trades);
  const sequence = analyzeDecisionSequence(body.trades, baseline);
  const pacing   = analyzePacing(body.trades, baseline);
  const escalation = detectEscalation(body.trades, baseline);
  const trajectory = body.recoveryTriggerAt
    ? analyzeRecoveryTrajectory({
        trades: body.trades, triggerAt: body.recoveryTriggerAt,
        windowMinutes: body.recoveryWindowMinutes, baseline,
      })
    : null;

  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "DECISION_SEQUENCE_ANALYZED", severity: "INFO",
    payload: {
      traderId: body.id, motifs: sequence.motifs.length,
      worstSeverity: sequence.worstSeverity,
      sequenceRiskScore01: sequence.sequenceRiskScore01,
      pacingState: pacing.pacingState, pacingRiskScore01: pacing.pacingRiskScore01,
      baselineMature: baseline.isMature,
    },
  });
  if (escalation.detected) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "ESCALATION_PATTERN_DETECTED",
      severity: escalation.escalationRiskScore01 >= 0.65 ? "DANGER" : "WARN",
      payload: {
        traderId: body.id, kind: escalation.kind,
        startTradeId: escalation.startTradeId, endTradeId: escalation.endTradeId,
        sizeSlopePerStep: escalation.sizeSlopePerStep,
        freqSlopePerStep: escalation.freqSlopePerStep,
        riskScore01: escalation.escalationRiskScore01,
      },
    });
  }

  res.json({ ok: true, canPlaceTrades: false,
    baseline, sequence, pacing, escalation, recoveryTrajectory: trajectory });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/contextual/analyze
// ───────────────────────────────────────────────────────────────────────
const ContextualAnalyzeBody = z.object({
  id: TraderIdSchema,
  context: ContextualBehaviorInputSchema,
}).strict();

router.post("/trader-dna/contextual/analyze", async (req: Request, res: Response) => {
  let body: z.infer<typeof ContextualAnalyzeBody>;
  try { body = ContextualAnalyzeBody.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const report = composeContextualBehavior(body.context);
  if (report.adjustedRiskScore01 >= 0.50) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "CONTEXTUAL_BEHAVIOR_HIT",
      severity: report.adjustedRiskScore01 >= 0.85 ? "DANGER"
              : report.adjustedRiskScore01 >= 0.65 ? "WARN" : "INFO",
      payload: {
        traderId: body.id,
        baseRiskScore01: report.baseRiskScore01,
        adjustedRiskScore01: report.adjustedRiskScore01,
        totalMultiplier: report.totalMultiplier,
        dominantAmplifier: report.dominantAmplifier,
      },
    });
  }
  res.json({ ok: true, canPlaceTrades: false, report });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/recovery/effectiveness
// ───────────────────────────────────────────────────────────────────────
const RecoveryEffectivenessBody = z.object({
  id: TraderIdSchema,
  cooldownHistory:    z.array(CooldownRecordSchema).default([]),
  restrictionHistory: z.array(RestrictionRecordSchema).default([]),
  singleEvent: z.object({
    eventKind: RecoveryEventKindSchema,
    preMetrics:  z.object({ behaviorRiskScore01: z.number().min(0).max(1),
                            disciplineScore01:   z.number().min(0).max(1),
                            cognitiveRisk01:     z.number().min(0).max(1) }),
    postMetrics: z.object({ behaviorRiskScore01: z.number().min(0).max(1),
                            disciplineScore01:   z.number().min(0).max(1),
                            cognitiveRisk01:     z.number().min(0).max(1) }),
  }).optional(),
}).strict();

router.post("/trader-dna/recovery/effectiveness", async (req: Request, res: Response) => {
  let body: z.infer<typeof RecoveryEffectivenessBody>;
  try { body = RecoveryEffectivenessBody.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const cooldowns    = analyzeCooldownEffectiveness(body.cooldownHistory);
  const restrictions = analyzeRestrictionEffectiveness(body.restrictionHistory);
  const single = body.singleEvent ? measureRecoveryEffectiveness(body.singleEvent) : null;

  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "RECOVERY_EFFECTIVENESS_MEASURED",
    severity: (single?.classification === "COUNTERPRODUCTIVE") ? "DANGER"
            : (cooldowns.averageEffectiveness01 < 0.45 ? "WARN" : "INFO"),
    payload: {
      traderId: body.id,
      cooldownAvg01: cooldowns.averageEffectiveness01,
      cooldownRecommendedMin: cooldowns.recommendedNextDurationMinutes,
      restrictionRecommendedCount: restrictions.recommended.length,
      restrictionNotRecommendedCount: restrictions.notRecommended.length,
      singleClassification: single?.classification ?? null,
      singleScore01: single?.effectivenessScore01 ?? null,
    },
  });

  res.json({ ok: true, canPlaceTrades: false, cooldowns, restrictions, single });
});

// ───────────────────────────────────────────────────────────────────────
// /api/cognitive/adaptive/recommend
// ───────────────────────────────────────────────────────────────────────
const AdaptiveRecommendBody = z.object({
  id: TraderIdSchema,
  cognitiveLoad01: z.number().min(0).max(1),
  behaviorRisk01:  z.number().min(0).max(1),
  fatigueScore01:  z.number().min(0).max(1).default(0),
  recentMedianGapMin: z.number().nonnegative().default(0),
  baselineGapMin:     z.number().nonnegative().default(0),
  recentAcknowledgmentsMissed: z.number().int().nonnegative().default(0),
  averageRecoveryEffectiveness01: z.number().min(0).max(1).default(0.5),
  recentRuleViolations24h: z.number().int().nonnegative().default(0),
  cognitiveRisk01: z.number().min(0).max(1).default(0),
}).strict();

router.post("/cognitive/adaptive/recommend", async (req: Request, res: Response) => {
  let body: z.infer<typeof AdaptiveRecommendBody>;
  try { body = AdaptiveRecommendBody.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const severity = Math.max(body.cognitiveLoad01, body.behaviorRisk01);
  const pacing = recommendAdaptivePacing({
    cognitiveLoad01: body.cognitiveLoad01,
    behaviorRisk01:  body.behaviorRisk01,
    recentMedianGapMin: body.recentMedianGapMin,
    baselineGapMin:     body.baselineGapMin,
  });
  const notification = recommendNotificationIntensity({
    severity01: severity,
    recentAcknowledgmentsMissed: body.recentAcknowledgmentsMissed,
  });
  const ui = recommendUIDensity({
    cognitiveLoad01: body.cognitiveLoad01,
    fatigueScore01:  body.fatigueScore01,
  });
  // Feed unified severity into permission sensitivity so it cannot return
  // RELAXED while pacing/notifications are at high severity.
  const permission = recommendPermissionSensitivity({
    averageRecoveryEffectiveness01: body.averageRecoveryEffectiveness01,
    recentRuleViolations24h: body.recentRuleViolations24h,
    cognitiveRisk01: Math.max(body.cognitiveRisk01, severity),
  });

  await shadowCapture({
    source: "COGNITIVE", systemMode: null, globalState: null,
    eventType: "ADAPTIVE_RECOMMENDATION_ISSUED",
    severity: severity >= 0.85 ? "DANGER" : severity >= 0.50 ? "WARN" : "INFO",
    payload: {
      traderId: body.id, severity01: round2(severity),
      pacing: { targetGapMinutes: pacing.targetGapMinutes,
                maxTradesPerSession: pacing.maxTradesPerSession,
                oneCandleDelay: pacing.oneCandleDelay },
      notification: { level: notification.level, requireAck: notification.requireAck },
      ui: { density: ui.density },
      permission: { sensitivity: permission.sensitivity,
                    thresholdMultiplier: permission.thresholdMultiplier },
    },
  });

  res.json({ ok: true, canPlaceTrades: false,
    severity01: round2(severity),
    pacing, notification, ui, permission });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/long-horizon/drift
// ───────────────────────────────────────────────────────────────────────
const DriftBody = z.object({
  id: TraderIdSchema,
  disciplinePoints: z.array(DailyDisciplinePointSchema).default([]),
  aggressionPoints: z.array(DailyAggressionPointSchema).default([]),
  overridePoints:   z.array(DailyOverridePointSchema).default([]),
}).strict();

router.post("/trader-dna/long-horizon/drift", async (req: Request, res: Response) => {
  let body: z.infer<typeof DriftBody>;
  try { body = DriftBody.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const drift = detectBehavioralDrift({
    disciplinePoints: body.disciplinePoints,
    aggressionPoints: body.aggressionPoints,
    overridePoints:   body.overridePoints,
  });

  if (drift.driftClassification === "DEGRADING") {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "BEHAVIORAL_DRIFT_DETECTED",
      severity: drift.driftRiskScore01 >= 0.65 ? "DANGER"
              : drift.driftRiskScore01 >= 0.35 ? "WARN" : "INFO",
      payload: {
        traderId: body.id,
        sampleDays: drift.sampleDays,
        driftRiskScore01: drift.driftRiskScore01,
        dominantDriver: drift.dominantDriver,
        disciplineDirection: drift.components.discipline.direction,
        aggressionDirection: drift.components.aggression.direction,
        overrideDirection: drift.components.override.direction,
      },
    });
  }
  res.json({ ok: true, canPlaceTrades: false, drift });
});

function round2(n: number) { return Math.round(n * 100) / 100; }

export default router;
