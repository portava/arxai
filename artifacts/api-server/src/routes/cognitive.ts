// ═══════════════════════════════════════════════════════════════════════════
// /api/cognitive — Phase 5 Cognitive Performance + Cooldown endpoints.
//
// Advisory only. canPlaceTrades:false. Vault-logs assessments + cooldown
// recommendations. Outputs are consumed by Risk Governor (cognitive risk
// score → revenge level) and Control Tower (forcesRecovery flag).
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  computeCognitiveLoad, computeStressState, computeFatigueState,
  planPacing, assessEmotionalDegradation, evaluateCognitivePerformance,
  composeCognitiveRiskScore,
  planCooldown,
  type CognitiveVerdict, type CognitiveRiskScore,
} from "@workspace/domain/cognitive";
import {
  type RevengeLevel,
} from "@workspace/domain/risk-governor";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

// ── Map a cognitive risk score to a Risk Governor RevengeLevel input ──
//    Risk Governor's REVENGE_TRADING kill-switch consumes this; the field is
//    overloaded to also surface cognitive lockouts because it's the only
//    person-state input the governor exposes.
function cognitiveRiskToRevengeLevel(score: CognitiveRiskScore, verdict: CognitiveVerdict): RevengeLevel {
  if (verdict.permission === "COOLDOWN" || score.level === "CRITICAL") return "CRITICAL";
  if (verdict.permission === "RECOVERY_MODE" || score.level === "HIGH") return "HIGH";
  if (score.level === "MEDIUM") return "MEDIUM";
  if (score.level === "LOW") return "LOW";
  return "NONE";
}

const AssessBodySchema = z.object({
  load: z.object({
    openPositionsCount: z.number().nonnegative(),
    activeAlertsCount: z.number().nonnegative(),
    screensWatched: z.number().nonnegative(),
    multitaskingFraction01: z.number().min(0).max(1),
    inputRatePerMin: z.number().nonnegative(),
  }).strict(),
  stress: z.object({
    drawdownShock01: z.number().min(0).max(1),
    mtmVolatility01: z.number().min(0).max(1),
    errorRate01: z.number().min(0).max(1),
    consecutiveLosses: z.number().int().nonnegative(),
  }).strict(),
  fatigue: z.object({
    decisionsLastHour: z.number().int().nonnegative(),
    errorsLastHour: z.number().int().nonnegative(),
    hoursActive: z.number().nonnegative(),
  }).strict(),
  emotional: z.object({
    rapidFireEntriesLastMinute: z.number().int().nonnegative(),
  }).strict(),
}).strict();

router.post("/cognitive/assess", async (req: Request, res: Response) => {
  let body: z.infer<typeof AssessBodySchema>;
  try { body = AssessBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const load     = computeCognitiveLoad(body.load);
  const stress   = computeStressState(body.stress);
  const fatigue  = computeFatigueState(body.fatigue);
  const pacing   = planPacing({ load, fatigue, stress });
  const emotional = assessEmotionalDegradation({
    stress, fatigue,
    consecutiveLosses: body.stress.consecutiveLosses,
    rapidFireEntriesLastMinute: body.emotional.rapidFireEntriesLastMinute,
    uiLoad01: load.load01,
  });
  const verdict = evaluateCognitivePerformance({ load, stress, fatigue, pacing, emotional });
  const cognitiveRisk = composeCognitiveRiskScore({
    load01: load.load01, stress01: stress.stress01,
    fatigue01: fatigue.fatigue01, degradation01: emotional.degradation01,
    acuteSpike: stress.acuteSpike, revengeRiskFlag: emotional.revengeRiskFlag,
  });

  const revengeLevelForGovernor = cognitiveRiskToRevengeLevel(cognitiveRisk, verdict);

  await shadowCapture({
    source: "COGNITIVE", systemMode: null, globalState: null,
    eventType: "COGNITIVE_ASSESSED",
    severity: cognitiveRisk.level === "CRITICAL" ? "CRITICAL"
            : cognitiveRisk.level === "HIGH" ? "WARN" : "INFO",
    payload: {
      cognitiveRiskScore: cognitiveRisk.score01,
      level: cognitiveRisk.level,
      permission: verdict.permission,
      cooldownMinutes: verdict.cooldownMinutes,
      fatigue: fatigue.fatigue01, stress: stress.stress01,
      load: load.load01, degradation: emotional.degradation01,
      revengeRiskFlag: emotional.revengeRiskFlag,
      revengeLevelForGovernor,
    },
  });

  res.json({
    ok: true, canPlaceTrades: false,
    snapshot: { load, stress, fatigue, pacing, emotional },
    verdict, cognitiveRiskScore: cognitiveRisk,
    revengeLevelForGovernor,
    fatigueRisk: fatigue.fatigue01,
    cognitiveRisk01: cognitiveRisk.score01,
  });
});

const CooldownBodySchema = AssessBodySchema.extend({
  trader: z.object({
    permission: z.enum(["FULL","REDUCED","MICRO","COOLDOWN","LOCKDOWN"]).optional(),
    revengeDetected: z.boolean().optional(),
    revengeSeverity: z.enum(["NONE","LOW","MEDIUM","HIGH","CRITICAL"]).optional(),
    overtradeDetected: z.boolean().optional(),
    overtradeSeverity: z.enum(["NONE","LOW","MEDIUM","HIGH","CRITICAL"]).optional(),
    overtradeRecommendBlock: z.boolean().optional(),
  }).strict().optional(),
}).strict();

router.post("/cognitive/cooldown-plan", async (req: Request, res: Response) => {
  let body: z.infer<typeof CooldownBodySchema>;
  try { body = CooldownBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const load     = computeCognitiveLoad(body.load);
  const stress   = computeStressState(body.stress);
  const fatigue  = computeFatigueState(body.fatigue);
  const pacing   = planPacing({ load, fatigue, stress });
  const emotional = assessEmotionalDegradation({
    stress, fatigue,
    consecutiveLosses: body.stress.consecutiveLosses,
    rapidFireEntriesLastMinute: body.emotional.rapidFireEntriesLastMinute,
    uiLoad01: load.load01,
  });
  const verdict = evaluateCognitivePerformance({ load, stress, fatigue, pacing, emotional });
  const cognitiveRisk = composeCognitiveRiskScore({
    load01: load.load01, stress01: stress.stress01,
    fatigue01: fatigue.fatigue01, degradation01: emotional.degradation01,
    acuteSpike: stress.acuteSpike, revengeRiskFlag: emotional.revengeRiskFlag,
  });

  const trader = body.trader;
  const plan = planCooldown({
    cognitive: verdict, cognitiveRisk, emotional,
    revenge: trader?.revengeDetected ? {
      detected: true,
      severity: trader.revengeSeverity ?? "MEDIUM",
      confidence: 80, evidence: ["client-supplied"], recommendation: null,
      cooldownUntil: null, triggeringLossId: null, followUpTrades: [],
    } : null,
    overtrade: trader?.overtradeDetected ? {
      detected: true,
      severity: trader.overtradeSeverity ?? "MEDIUM",
      confidence: 80, evidence: ["client-supplied"], recommendation: null,
      tradesToday: 0, baseline: 0, ratio: 0,
      recommendBlock: !!trader.overtradeRecommendBlock,
    } : null,
    trader: trader?.permission ? {
      score01: 0, level: "NONE",
      components: { revenge01: 0, overtrade01: 0, behavior01: 0, edgeWeakness01: 0 },
      permission: trader.permission,
      recommendedAction: "EXECUTE", reasons: [], warnings: [],
    } : undefined,
  });

  if (plan.kind !== "NONE") {
    await shadowCapture({
      source: "COGNITIVE", systemMode: null, globalState: null,
      eventType: "COOLDOWN_RECOMMENDED",
      severity: plan.kind === "LOCKDOWN" ? "CRITICAL" : "WARN",
      payload: {
        kind: plan.kind, durationMinutes: plan.durationMinutes,
        forcesRecovery: plan.forcesRecovery, forcesLockdown: plan.forcesLockdown,
        reasons: plan.reasons,
      },
    });
  }

  res.json({
    ok: true, canPlaceTrades: false,
    plan, cognitiveRiskScore: cognitiveRisk,
    forcesRecovery: plan.forcesRecovery,
    forcesLockdown: plan.forcesLockdown,
  });
});

export default router;
