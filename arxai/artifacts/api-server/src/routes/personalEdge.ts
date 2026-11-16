// ═══════════════════════════════════════════════════════════════════════════
// /api/trader-dna/* and /api/cognitive/* — Personal Edge + Behavior Risk
// Intelligence System (Phase 5 upgrade).
//
// Strict, advisory only. canPlaceTrades:false on every response. Every
// computed score and verdict is logged to the Black Box Vault. No live
// trade placement. Language is neutral — never labels emotional state.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { TradeSchema } from "@workspace/domain/trade";
import {
  TradeWithContextSchema,
  buildPersonalBaseline,
  analyzePostLossBehavior,
  analyzeOverrides, OverrideRecordSchema,
  computeDisciplineScore,
  buildDrawdownProfile,
  buildBestConditions,
  buildWorstConditions,
  buildPersonalEdgeFingerprint, buildPersonalDangerFingerprint,
  composeBehaviorEvidence,
  classifyTraderState,
  buildPersonalEdgeMap,
  analyzeSymbolPerformance,
  analyzeStrategyPerformanceByTrader,
  analyzeSessionPerformance,
  analyzeBehaviorPatterns,
  detectRevengeTrading,
  evaluateOvertrade,
  computeTraderRiskScore,
  type TraderProfile,
} from "@workspace/domain/trader-dna";
import {
  computeCognitiveLoad, computeStressState, computeFatigueState,
  planPacing, assessEmotionalDegradation,
  composeBehavioralRiskEvidence,
  recommendCooldownPolicy,
  recommendPermissionThrottle,
  computeCognitiveRecoveryScore,
} from "@workspace/domain/cognitive";
import {
  buildPersonalRiskPrescription,
  evaluateRecovery, RecoveryObservationSchema,
} from "@workspace/domain/trader-dna";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/baseline — build the personal baseline + maturity flag
// ───────────────────────────────────────────────────────────────────────
const BaselineBodySchema = z.object({
  id: z.string().min(1),
  trades: z.array(TradeSchema),
}).strict();

router.post("/trader-dna/baseline", async (req: Request, res: Response) => {
  let body: z.infer<typeof BaselineBodySchema>;
  try { body = BaselineBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const baseline = buildPersonalBaseline(body.trades);
  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: baseline.isMature ? "BASELINE_BUILT" : "BASELINE_IMMATURE",
    severity: "INFO",
    payload: {
      traderId: body.id, isMature: baseline.isMature,
      sample: baseline.sample, activeDays: baseline.activeDays,
      tradesPerDay: baseline.tradesPerDay,
      maturityReasons: baseline.maturityReasons,
    },
  });
  res.json({ ok: true, canPlaceTrades: false, baseline });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/edge-fingerprint — best + danger fingerprints
// ───────────────────────────────────────────────────────────────────────
const FingerprintBodySchema = z.object({
  id: z.string().min(1),
  trades: z.array(TradeSchema),
  contextTrades: z.array(TradeWithContextSchema).optional(),
}).strict();

router.post("/trader-dna/edge-fingerprint", async (req: Request, res: Response) => {
  let body: z.infer<typeof FingerprintBodySchema>;
  try { body = FingerprintBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const ctx = body.contextTrades ?? body.trades.map(t => ({ ...t, strategyId: "UNKNOWN" }));
  const edgeMap     = buildPersonalEdgeMap(ctx);
  const symbolPerf  = analyzeSymbolPerformance(body.trades);
  const sessionPerf = analyzeSessionPerformance(body.trades);
  const strategyPerf = analyzeStrategyPerformanceByTrader(ctx);
  const best = buildBestConditions({
    edgeMap, symbolStats: symbolPerf.bySymbol, sessionPerf: sessionPerf.bySession, strategyStats: strategyPerf.byStrategy,
  });
  const worst = buildWorstConditions({
    edgeMap, symbolStats: symbolPerf.bySymbol, sessionPerf: sessionPerf.bySession, strategyStats: strategyPerf.byStrategy,
  });
  const personalEdgeFingerprint   = buildPersonalEdgeFingerprint(best);
  const personalDangerFingerprint = buildPersonalDangerFingerprint(worst);

  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "EDGE_FINGERPRINT_BUILT", severity: "INFO",
    payload: {
      traderId: body.id,
      edgeSignature: personalEdgeFingerprint.signature,
      dangerSignature: personalDangerFingerprint.signature,
      personalEdgeScore: edgeMap.personalEdgeScore01,
    },
  });

  res.json({
    ok: true, canPlaceTrades: false,
    bestConditions: best, worstConditions: worst,
    personalEdgeFingerprint, personalDangerFingerprint,
    edgeMap,
  });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/behavior-evidence — full evidence ledger + state
// ───────────────────────────────────────────────────────────────────────
const BehaviorEvidenceBodySchema = z.object({
  id: z.string().min(1),
  trades: z.array(TradeSchema),
  overrides: z.array(OverrideRecordSchema).optional(),
  ruleViolationsLast24h: z.number().int().nonnegative().optional(),
  startingEquity: z.number().positive().optional(),
  currentTradesPerDay: z.number().nonnegative().optional(),
  currentAvgLot: z.number().nonnegative().optional(),
  currentAvgHoldMinutes: z.number().nonnegative().optional(),
  lateSessionTradesLastDay: z.number().int().nonnegative().optional(),
  forcePaperOnly: z.boolean().optional(),
  cognitiveRiskScore01: z.number().min(0).max(1).optional(),
}).strict();

router.post("/trader-dna/behavior-evidence", async (req: Request, res: Response) => {
  let body: z.infer<typeof BehaviorEvidenceBodySchema>;
  try { body = BehaviorEvidenceBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const baseline = buildPersonalBaseline(body.trades);

  const profile: TraderProfile = {
    id: body.id, name: body.id, traits: [],
    baselineTradesPerDay: baseline.tradesPerDay,
    baselineLotSize: baseline.lotSize.median,
    baselineWinRate: baseline.winRate01,
    baselineAvgRMultiple: baseline.avgRMultiple,
    observedPatterns: [], preferredSessions: [], avoidedSessions: [],
    lastUpdatedAt: new Date().toISOString(),
  };

  const behavior = analyzeBehaviorPatterns(profile, {
    trades: body.trades, windowStart: new Date(0), windowEnd: new Date(),
  });
  const revenge = detectRevengeTrading(profile, body.trades);
  const overtrade = evaluateOvertrade(profile, body.trades);
  const postLoss = analyzePostLossBehavior(body.trades, baseline);
  const overrideReport = analyzeOverrides(body.overrides ?? [], body.trades, baseline);
  const drawdown = buildDrawdownProfile(body.trades, body.startingEquity);

  const evidence = composeBehaviorEvidence({
    baseline, patterns: behavior.hits, revenge, overtrade, postLoss,
    overrides: overrideReport, drawdown,
    currentTradesPerDay: body.currentTradesPerDay,
    currentAvgLot: body.currentAvgLot,
    currentAvgHoldMinutes: body.currentAvgHoldMinutes,
    lateSessionTradesLastDay: body.lateSessionTradesLastDay,
  });

  const discipline = computeDisciplineScore({
    overrideQualityScore01: overrideReport.overrideQualityScore01,
    postLossRiskScore01:    postLoss.postLossRiskScore01,
    ruleViolationsLast24h:  body.ruleViolationsLast24h ?? overrideReport.ruleViolatedCount,
    patterns: behavior.hits,
  });

  const state = classifyTraderState({
    behaviorEvidence: evidence, discipline, postLoss,
  });

  // Compose traderRiskScore (Risk Governor consumes this)
  const edgeStub = 0.5;
  const traderRisk = computeTraderRiskScore({
    patterns: behavior.hits, revenge, overtrade,
    personalEdgeScore01: edgeStub,
  });

  // Permission throttle (Control Tower consumes recommendedPermissionLevel)
  const throttle = recommendPermissionThrottle({
    traderRiskScore01: traderRisk.score01,
    behaviorEvidenceScore01: evidence.behaviorEvidenceScore01,
    disciplineScore01: discipline.score01,
    cognitiveRiskScore01: body.cognitiveRiskScore01 ?? 0,
    baselineMature: baseline.isMature,
    forcePaperOnly: body.forcePaperOnly,
  });

  // Vault every meaningful evidence item + scores
  if (postLoss.postLossSample > 0 && postLoss.postLossRiskScore01 >= 0.30) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "POST_LOSS_RISK_DETECTED",
      severity: postLoss.postLossRiskScore01 >= 0.65 ? "WARN" : "INFO",
      payload: { traderId: body.id, postLossRiskScore: postLoss.postLossRiskScore01,
        postLossSample: postLoss.postLossSample, lossesScanned: postLoss.lossesScanned },
    });
  }
  if (overrideReport.totalOverrides > 0) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "OVERRIDE_FORENSICS_LOGGED",
      severity: overrideReport.ruleViolatedCount > 0 ? "WARN" : "INFO",
      payload: {
        traderId: body.id,
        total: overrideReport.totalOverrides,
        ruleViolated: overrideReport.ruleViolatedCount,
        increasedRisk: overrideReport.increasedRiskCount,
        afterLoss: overrideReport.afterLossCount,
        overrideQualityScore: overrideReport.overrideQualityScore01,
      },
    });
  }
  if (drawdown.drawdownRiskScore01 >= 0.30) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "DRAWDOWN_PROFILE_LOGGED",
      severity: drawdown.drawdownRiskScore01 >= 0.65 ? "WARN" : "INFO",
      payload: { traderId: body.id, drawdownRiskScore: drawdown.drawdownRiskScore01,
        currentDrawdownPct: drawdown.currentDrawdownPct, maxDrawdownPct: drawdown.maxDrawdownPct },
    });
  }
  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "DISCIPLINE_SCORED", severity: "INFO",
    payload: { traderId: body.id, disciplineScore: discipline.score01, level: discipline.level },
  });
  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "BEHAVIOR_EVIDENCE_LOGGED",
    severity: evidence.worstSeverity === "CRITICAL" ? "CRITICAL"
            : evidence.worstSeverity === "HIGH" ? "WARN" : "INFO",
    payload: {
      traderId: body.id,
      behaviorEvidenceScore: evidence.behaviorEvidenceScore01,
      worstSeverity: evidence.worstSeverity,
      hasMatureBaseline: evidence.hasMatureBaseline,
      itemCount: evidence.items.length,
    },
  });
  // Per-item vaulting (every evidence item recorded individually)
  for (const item of evidence.items) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "BEHAVIOR_EVIDENCE_ITEM",
      severity: item.severity === "CRITICAL" ? "CRITICAL"
              : item.severity === "HIGH" ? "WARN" : "INFO",
      payload: {
        traderId: body.id,
        kind: item.kind,
        severity: item.severity,
        deltaVsBaseline: item.deltaVsBaseline,
        evidence: item.evidence,
        neutralLanguage: item.neutralLanguage,
      },
    });
  }
  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "TRADER_STATE_CLASSIFIED",
    severity: state.state === "CRITICAL" ? "CRITICAL"
            : state.state === "HIGH_RISK" ? "WARN" : "INFO",
    payload: { traderId: body.id, state: state.state, requiresBaseline: state.requiresBaseline },
  });
  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "PERMISSION_THROTTLE_APPLIED",
    severity: throttle.level === "COOLDOWN" ? "CRITICAL"
            : throttle.level === "PAPER_ONLY" ? "WARN" : "INFO",
    payload: {
      traderId: body.id, level: throttle.level,
      sizeMultiplier: throttle.sizeMultiplier,
      requireConfirmation: throttle.requireConfirmation,
      paperOnly: throttle.paperOnly, blockNewEntries: throttle.blockNewEntries,
    },
  });

  res.json({
    ok: true, canPlaceTrades: false,
    baseline, behaviorReport: behavior, revenge, overtrade,
    postLoss, overrideForensics: overrideReport, drawdown,
    behaviorEvidence: evidence,
    disciplineScore: discipline,
    traderState: state,
    traderRiskScore: traderRisk,
    permissionThrottle: throttle,
    // Spec-required surface fields
    behaviorEvidenceScore: evidence.behaviorEvidenceScore01,
    overrideQualityScore: overrideReport.overrideQualityScore01,
    postLossRiskScore: postLoss.postLossRiskScore01,
    disciplineScore01: discipline.score01,
    permissionThrottleLevel: throttle.level,
    // Control Tower consumes the new throttle level (FULL/REDUCED/CONFIRM_REQUIRED/MICRO/PAPER_ONLY/COOLDOWN).
    recommendedPermissionLevel: throttle.level,
    // Legacy Risk Governor field — preserved for the existing consumer.
    riskGovernorPermission: traderRisk.permission,
  });
});

// ───────────────────────────────────────────────────────────────────────
// /api/cognitive/risk-evidence — evidence-based cognitive risk
// ───────────────────────────────────────────────────────────────────────
const CognitiveSnapshotInputSchema = z.object({
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

router.post("/cognitive/risk-evidence", async (req: Request, res: Response) => {
  let body: z.infer<typeof CognitiveSnapshotInputSchema>;
  try { body = CognitiveSnapshotInputSchema.parse(req.body); }
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

  const evidence = composeBehavioralRiskEvidence({
    load, stress, fatigue, emotional,
    rapidFireEntriesLastMinute: body.emotional.rapidFireEntriesLastMinute,
  });

  await shadowCapture({
    source: "COGNITIVE", systemMode: null, globalState: null,
    eventType: "BEHAVIORAL_RISK_EVIDENCE_LOGGED",
    severity: evidence.worstSeverity === "CRITICAL" ? "CRITICAL"
            : evidence.worstSeverity === "HIGH" ? "WARN" : "INFO",
    payload: {
      score: evidence.behavioralRiskEvidenceScore01,
      worstSeverity: evidence.worstSeverity,
      itemCount: evidence.items.length,
    },
  });
  // Per-item vaulting for cognitive evidence
  for (const item of evidence.items) {
    await shadowCapture({
      source: "COGNITIVE", systemMode: null, globalState: null,
      eventType: "COGNITIVE_EVIDENCE_ITEM",
      severity: item.severity === "CRITICAL" ? "CRITICAL"
              : item.severity === "HIGH" ? "WARN" : "INFO",
      payload: {
        kind: item.kind,
        severity: item.severity,
        observed: item.observed,
        threshold: item.threshold,
        neutralLanguage: item.neutralLanguage,
      },
    });
  }

  res.json({
    ok: true, canPlaceTrades: false,
    snapshot: { load, stress, fatigue, pacing, emotional },
    evidence,
    behavioralRiskEvidenceScore: evidence.behavioralRiskEvidenceScore01,
  });
});

// ───────────────────────────────────────────────────────────────────────
// /api/cognitive/permission-throttle — throttle + cooldown policy + recovery
// ───────────────────────────────────────────────────────────────────────
const ThrottleBodySchema = z.object({
  traderRiskScore01: z.number().min(0).max(1),
  behaviorEvidenceScore01: z.number().min(0).max(1),
  disciplineScore01: z.number().min(0).max(1),
  cognitiveRiskScore01: z.number().min(0).max(1),
  baselineMature: z.boolean(),
  forcePaperOnly: z.boolean().optional(),
  // For the cooldown policy
  repeatOffenseCount: z.number().int().nonnegative().optional(),
  allowConfirmedOverride: z.boolean().optional(),
  // For the recovery score
  cognitiveRiskSeries: z.array(z.number().min(0).max(1)).optional(),
  ruleAdherenceLast24h: z.number().min(0).max(1).optional(),
  baselineDeviation01: z.number().min(0).max(1).optional(),
  minutesSinceLastCooldown: z.number().nonnegative().optional(),
  restoreThreshold01: z.number().min(0).max(1).optional(),
}).strict();

router.post("/cognitive/permission-throttle", async (req: Request, res: Response) => {
  let body: z.infer<typeof ThrottleBodySchema>;
  try { body = ThrottleBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const throttle = recommendPermissionThrottle({
    traderRiskScore01: body.traderRiskScore01,
    behaviorEvidenceScore01: body.behaviorEvidenceScore01,
    disciplineScore01: body.disciplineScore01,
    cognitiveRiskScore01: body.cognitiveRiskScore01,
    baselineMature: body.baselineMature,
    forcePaperOnly: body.forcePaperOnly,
  });

  // Worst-axis severity drives the cooldown policy
  const severity = Math.max(
    body.traderRiskScore01, body.behaviorEvidenceScore01,
    body.cognitiveRiskScore01, 1 - body.disciplineScore01,
  );
  const policy = recommendCooldownPolicy({
    severityScore01: severity,
    baselineMature: body.baselineMature,
    repeatOffenseCount: body.repeatOffenseCount ?? 0,
    disciplineScore01: body.disciplineScore01,
    allowConfirmedOverride: body.allowConfirmedOverride,
  });

  const recovery = computeCognitiveRecoveryScore({
    cognitiveRiskSeries: body.cognitiveRiskSeries ?? [body.cognitiveRiskScore01],
    ruleAdherenceLast24h: body.ruleAdherenceLast24h ?? 1,
    baselineDeviation01: body.baselineDeviation01 ?? body.behaviorEvidenceScore01,
    minutesSinceLastCooldown: body.minutesSinceLastCooldown ?? 0,
    restoreThreshold01: body.restoreThreshold01,
  });

  await shadowCapture({
    source: "COGNITIVE", systemMode: null, globalState: null,
    eventType: "PERMISSION_THROTTLE_APPLIED",
    severity: throttle.level === "COOLDOWN" ? "CRITICAL"
            : throttle.level === "PAPER_ONLY" ? "WARN" : "INFO",
    payload: { level: throttle.level, sizeMultiplier: throttle.sizeMultiplier,
      requireConfirmation: throttle.requireConfirmation, paperOnly: throttle.paperOnly,
      blockNewEntries: throttle.blockNewEntries },
  });
  if (policy.kind !== "NONE") {
    await shadowCapture({
      source: "COGNITIVE", systemMode: null, globalState: null,
      eventType: "COOLDOWN_POLICY_RECOMMENDED",
      severity: policy.kind === "LOCKDOWN" ? "CRITICAL"
              : policy.kind === "RECOVERY_MODE" ? "WARN" : "INFO",
      payload: { kind: policy.kind, durationMinutes: policy.durationMinutes,
        forcesRecovery: policy.forcesRecovery, forcesLockdown: policy.forcesLockdown,
        allowConfirmedOverride: policy.allowConfirmedOverride },
    });
  }
  await shadowCapture({
    source: "COGNITIVE", systemMode: null, globalState: null,
    eventType: "COGNITIVE_RECOVERY_SCORED",
    severity: recovery.canRestorePermissions ? "INFO" : "INFO",
    payload: { recoveryScore: recovery.recoveryScore01,
      canRestorePermissions: recovery.canRestorePermissions, trend: recovery.trend },
  });

  res.json({
    ok: true, canPlaceTrades: false,
    permissionThrottle: throttle,
    cooldownRecommendation: policy,
    cognitiveRecovery: recovery,
    // Spec-required surface fields
    permissionThrottleLevel: throttle.level,
    cognitiveRecoveryScore: recovery.recoveryScore01,
  });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/prescription — Personal Risk Prescription
// ───────────────────────────────────────────────────────────────────────
const PrescriptionBodySchema = z.object({
  id: z.string().min(1),
  trades: z.array(TradeSchema),
  contextTrades: z.array(TradeWithContextSchema).optional(),
  overrides: z.array(OverrideRecordSchema).optional(),
  ruleViolationsLast24h: z.number().int().nonnegative().optional(),
  startingEquity: z.number().positive().optional(),
  cognitiveRiskScore01: z.number().min(0).max(1).optional(),
  cooldownMinutes: z.number().nonnegative().optional(),
  forcePaperOnly: z.boolean().optional(),
  // Optional recovery observation — when supplied, the endpoint also evaluates
  // whether the trader has met the prescription's restore conditions.
  observation: RecoveryObservationSchema.optional(),
}).strict();

router.post("/trader-dna/prescription", async (req: Request, res: Response) => {
  let body: z.infer<typeof PrescriptionBodySchema>;
  try { body = PrescriptionBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const baseline = buildPersonalBaseline(body.trades);
  const ctx = body.contextTrades ?? body.trades.map(t => ({ ...t, strategyId: "UNKNOWN" }));
  const edgeMap = buildPersonalEdgeMap(ctx);
  const symbolPerf = analyzeSymbolPerformance(body.trades);
  const sessionPerf = analyzeSessionPerformance(body.trades);
  const strategyPerf = analyzeStrategyPerformanceByTrader(ctx);
  const worst = buildWorstConditions({
    edgeMap, symbolStats: symbolPerf.bySymbol,
    sessionPerf: sessionPerf.bySession, strategyStats: strategyPerf.byStrategy,
  });
  const dangerFingerprint = buildPersonalDangerFingerprint(worst);

  const profile: TraderProfile = {
    id: body.id, name: body.id, traits: [],
    baselineTradesPerDay: baseline.tradesPerDay,
    baselineLotSize: baseline.lotSize.median,
    baselineWinRate: baseline.winRate01,
    baselineAvgRMultiple: baseline.avgRMultiple,
    observedPatterns: [], preferredSessions: [], avoidedSessions: [],
    lastUpdatedAt: new Date().toISOString(),
  };
  const behavior = analyzeBehaviorPatterns(profile, {
    trades: body.trades, windowStart: new Date(0), windowEnd: new Date(),
  });
  const revenge = detectRevengeTrading(profile, body.trades);
  const overtrade = evaluateOvertrade(profile, body.trades);
  const postLoss = analyzePostLossBehavior(body.trades, baseline);
  const overrideReport = analyzeOverrides(body.overrides ?? [], body.trades, baseline);
  const drawdown = buildDrawdownProfile(body.trades, body.startingEquity);

  const evidence = composeBehaviorEvidence({
    baseline, patterns: behavior.hits, revenge, overtrade,
    postLoss, overrides: overrideReport, drawdown,
  });
  const discipline = computeDisciplineScore({
    overrideQualityScore01: overrideReport.overrideQualityScore01,
    postLossRiskScore01:    postLoss.postLossRiskScore01,
    ruleViolationsLast24h:  body.ruleViolationsLast24h ?? overrideReport.ruleViolatedCount,
    patterns: behavior.hits,
  });
  const traderRisk = computeTraderRiskScore({
    patterns: behavior.hits, revenge, overtrade,
    personalEdgeScore01: edgeMap.personalEdgeScore01,
  });

  const prescription = buildPersonalRiskPrescription({
    traderRiskScore01:        traderRisk.score01,
    behaviorEvidenceScore01:  evidence.behaviorEvidenceScore01,
    cognitiveRiskScore01:     body.cognitiveRiskScore01 ?? 0,
    disciplineScore01:        discipline.score01,
    postLossRiskScore01:      postLoss.postLossRiskScore01,
    drawdownRiskScore01:      drawdown.drawdownRiskScore01,
    baselineMature:           baseline.isMature,
    baselineLotSize:          baseline.lotSize.median,
    ruleViolationsLast24h:    body.ruleViolationsLast24h ?? overrideReport.ruleViolatedCount,
    cooldownMinutes:          body.cooldownMinutes ?? 0,
    forcePaperOnly:           body.forcePaperOnly,
    dangerFingerprint,
  });

  // Vault the prescription
  await shadowCapture({
    source: "TRADER_DNA", systemMode: null, globalState: null,
    eventType: "PERSONAL_RISK_PRESCRIPTION_ISSUED",
    severity: prescription.hardBlock ? "CRITICAL"
            : prescription.prescriptionLevel === "PAPER_ONLY" ? "WARN"
            : prescription.prescriptionLevel === "RECOVERY" ? "WARN" : "INFO",
    payload: {
      traderId: body.id,
      prescriptionLevel: prescription.prescriptionLevel,
      severity: prescription.severity01,
      hardBlock: prescription.hardBlock,
      restrictedActions: prescription.restrictedActions,
      allowedActions: prescription.allowedActions,
      cooldownMinutes: prescription.cooldownMinutes,
      explanation: prescription.explanation,
    },
  });
  // Per-restriction vaulting
  for (const action of prescription.restrictedActions) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "PRESCRIPTION_RESTRICTION",
      severity: prescription.hardBlock ? "WARN" : "INFO",
      payload: { traderId: body.id, restrictedAction: action,
        prescriptionLevel: prescription.prescriptionLevel },
    });
  }

  // Optional recovery evaluation
  let recoveryEvaluation = null;
  if (body.observation) {
    recoveryEvaluation = evaluateRecovery(
      { recoveryRequirements: prescription.recoveryRequirements,
        permissionRestoreConditions: prescription.permissionRestoreConditions },
      body.observation,
      { requiredPaperWins: prescription.policies.paperMode.requiredPaperWinsToRestore,
        minPaperWinRate: prescription.policies.paperMode.minPaperWinRate },
    );
    if (recoveryEvaluation.canRestore) {
      await shadowCapture({
        source: "TRADER_DNA", systemMode: null, globalState: null,
        eventType: "PERMISSION_RESTORATION_COMPLETED",
        severity: "INFO",
        payload: { traderId: body.id, prescriptionLevel: prescription.prescriptionLevel,
          satisfiedConditionsCount: recoveryEvaluation.satisfied.length },
      });
    } else {
      await shadowCapture({
        source: "TRADER_DNA", systemMode: null, globalState: null,
        eventType: "PERMISSION_RESTORATION_PENDING",
        severity: "INFO",
        payload: { traderId: body.id, prescriptionLevel: prescription.prescriptionLevel,
          pendingCount: recoveryEvaluation.pending.length,
          pending: recoveryEvaluation.pending.map(p => ({ kind: p.kind, remaining: p.remaining })) },
      });
    }
  }

  res.json({
    ok: true, canPlaceTrades: false,
    prescription,
    // Required output surface
    prescriptionLevel: prescription.prescriptionLevel,
    restrictedActions: prescription.restrictedActions,
    allowedActions: prescription.allowedActions,
    recoveryRequirements: prescription.recoveryRequirements,
    permissionRestoreConditions: prescription.permissionRestoreConditions,
    explanation: prescription.explanation,
    hardBlock: prescription.hardBlock,
    recoveryEvaluation,
  });
});

// ───────────────────────────────────────────────────────────────────────
// /api/trader-dna/prescription/evaluate-recovery — standalone restore check
// ───────────────────────────────────────────────────────────────────────
const EvalRecoveryBodySchema = z.object({
  id: z.string().min(1),
  prescription: z.object({
    permissionRestoreConditions: z.array(z.object({
      kind: z.string(), description: z.string(), threshold: z.number(),
    })),
    recoveryRequirements: z.array(z.string()),
    requiredPaperWins: z.number().int().nonnegative().default(0),
    minPaperWinRate: z.number().min(0).max(1).default(0),
  }),
  observation: RecoveryObservationSchema,
}).strict();

router.post("/trader-dna/prescription/evaluate-recovery", async (req: Request, res: Response) => {
  let body: z.infer<typeof EvalRecoveryBodySchema>;
  try { body = EvalRecoveryBodySchema.parse(req.body); }
  catch (err) { res.status(400).json({ error: "invalid body", detail: String(err) }); return; }

  const ev = evaluateRecovery(
    {
      recoveryRequirements: body.prescription.recoveryRequirements,
      // Cast: we accept generic shape but evaluator only reads the kind/threshold
      permissionRestoreConditions: body.prescription.permissionRestoreConditions as never,
    },
    body.observation,
    {
      requiredPaperWins: body.prescription.requiredPaperWins,
      minPaperWinRate: body.prescription.minPaperWinRate,
    },
  );

  if (ev.canRestore) {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "PERMISSION_RESTORATION_COMPLETED",
      severity: "INFO",
      payload: { traderId: body.id, satisfiedConditionsCount: ev.satisfied.length },
    });
  } else {
    await shadowCapture({
      source: "TRADER_DNA", systemMode: null, globalState: null,
      eventType: "PERMISSION_RESTORATION_PENDING",
      severity: "INFO",
      payload: { traderId: body.id, pendingCount: ev.pending.length,
        pending: ev.pending.map(p => ({ kind: p.kind, remaining: p.remaining })) },
    });
  }

  res.json({ ok: true, canPlaceTrades: false, evaluation: ev });
});

export default router;
