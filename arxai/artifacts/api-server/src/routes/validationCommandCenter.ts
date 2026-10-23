// ═══════════════════════════════════════════════════════════════════════════
// /api/validation/cc/* — Phase 7+: Validation Command Center.
//
// Institutional-grade validation. Builds on Phase 7 (`validationPipeline.ts`)
// by exposing seven explicit dimensions every candidate must clear before
// earning live authority. Every endpoint is ADVISORY (canPlaceTrades:false,
// mode:"VALIDATION_PIPELINE") and emits a vault event so the Black Box
// Vault has a permanent, replayable audit trail of every decision.
//
// Vault events:
//   VALIDATION_CC_STATISTICAL_SIGNIFICANCE_ASSESSED
//   VALIDATION_CC_MONTE_CARLO_RUN
//   VALIDATION_CC_REGIME_FIT_ASSESSED
//   VALIDATION_CC_STRESS_VALIDATED
//   VALIDATION_CC_EXECUTION_REALITY_ASSESSED
//   VALIDATION_CC_TRADER_BEHAVIOR_VALIDATED
//   VALIDATION_CC_EDGE_DURABILITY_ASSESSED
//   VALIDATION_CC_OUT_OF_SAMPLE_VALIDATED
//   VALIDATION_CC_CONFIDENCE_COMPUTED
//   VALIDATION_CC_SCORECARD_BUILT
//   VALIDATION_CC_DECISION
//   VALIDATION_CC_AUDIT_REPORT_GENERATED
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  assessStatisticalSignificance,
  runMonteCarloValidation,
  assessRegimeFit,
  runStressValidation,
  assessExecutionReality,
  assessTraderBehaviorSafety,
  assessEdgeDurability,
  assessOutOfSample,
  computeValidationConfidence,
  buildValidationScorecard,
  decideValidationCommandCenter,
  buildValidationAuditReport,
  type StatisticalSignificanceResult,
  type MonteCarloResult,
  type RegimeFitResult,
  type StressResult,
  type ExecutionRealityResult,
  type TraderBehaviorResult,
  type EdgeDurabilityResult,
  type OutOfSampleResult,
  type ScorecardResult,
  type CommandCenterResult,
} from "@workspace/domain/validation-command-center";
import { ValidationStageSchema } from "@workspace/domain/validation-pipeline";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "VALIDATION_PIPELINE" as never;
const ADVISORY = { canPlaceTrades: false as const, mode: "VALIDATION_PIPELINE" as const };

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}
function sevForScore(s: number, blockers: number = 0): "INFO" | "WARN" | "DANGER" | "CRITICAL" {
  if (blockers > 0 && s < 0.25) return "CRITICAL";
  if (s >= 0.7) return "INFO";
  if (s >= 0.5) return "WARN";
  if (s >= 0.25) return "DANGER";
  return "CRITICAL";
}

// ── Statistical Significance ─────────────────────────────────────────────
router.post("/validation/cc/statistical-significance", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    trades: z.int().nonnegative(),
    winRate01: z.number().min(0).max(1),
    avgWinR: z.number().nonnegative(),
    avgLossR: z.number().nonnegative(),
    sampleStddevR: z.number().nonnegative().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessStatisticalSignificance(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_STATISTICAL_SIGNIFICANCE_ASSESSED" as never,
    severity: sevForScore(result.score01),
    payload: {
      candidateId: body.candidateId,
      score01: result.score01,
      pValueOneSided01: result.pValueOneSided01,
      tStatistic: result.tStatistic,
      sampleAdequacy01: result.sampleAdequacy01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Out-of-Sample ────────────────────────────────────────────────────────
router.post("/validation/cc/out-of-sample", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    inSampleExpectancyR: z.number(),
    outOfSampleExpectancyR: z.number(),
    inSampleTrades: z.int().nonnegative(),
    outOfSampleTrades: z.int().nonnegative(),
    passRatio01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessOutOfSample(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_OUT_OF_SAMPLE_VALIDATED" as never,
    severity: result.oosPassing ? "INFO" : sevForScore(result.score01),
    payload: {
      candidateId: body.candidateId,
      ratio: result.ratio, oosPassing: result.oosPassing,
      overfittingProbability01: result.overfittingProbability01,
      score01: result.score01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Monte Carlo Stress ───────────────────────────────────────────────────
router.post("/validation/cc/monte-carlo", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    tradeRs: z.array(z.number()).min(1),
    simulations: z.int().positive().max(5000).optional(),
    slippageJitterR: z.number().nonnegative().optional(),
    spreadJitterR: z.number().nonnegative().optional(),
    latencyDelayJitter01: z.number().min(0).max(1).optional(),
    ruinThresholdR: z.number().optional(),
    seed: z.int().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = runMonteCarloValidation(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_MONTE_CARLO_RUN" as never,
    severity: sevForScore(result.score01),
    payload: {
      candidateId: body.candidateId,
      simulations: result.simulations,
      ruinProbability01: result.ruinProbability01,
      p05FinalR: result.p05FinalR,
      worstDrawdownR: result.worstDrawdownR,
      score01: result.score01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Regime Fit ───────────────────────────────────────────────────────────
// Zod v4's `z.record(enum, …)` requires every enum key be present. We want
// per-regime stats to be optional, so we declare each key explicitly and
// mark them all `.optional()`.
const RegimeStatsShape = z.object({
  trades: z.int().nonnegative(),
  expectancyR: z.number(),
  winRate01: z.number().min(0).max(1),
});
const ByRegimeSchema = z.object({
  TRENDING:       RegimeStatsShape.optional(),
  CHOPPY:         RegimeStatsShape.optional(),
  HIGH_VOL:       RegimeStatsShape.optional(),
  LOW_LIQ:        RegimeStatsShape.optional(),
  NEWS:           RegimeStatsShape.optional(),
  SESSION_LONDON: RegimeStatsShape.optional(),
  SESSION_NY:     RegimeStatsShape.optional(),
  SESSION_ASIA:   RegimeStatsShape.optional(),
}).strict();
router.post("/validation/cc/regime-fit", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    byRegime: ByRegimeSchema,
    minTradesPerRegime: z.int().nonnegative().optional(),
    minExpectancyPass: z.number().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessRegimeFit(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_REGIME_FIT_ASSESSED" as never,
    severity: sevForScore(result.score01),
    payload: {
      candidateId: body.candidateId,
      label: result.label,
      regimesPassing: result.regimesPassing,
      regimeFit01: result.regimeFit01,
      restrictions: result.restrictions,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Stress ───────────────────────────────────────────────────────────────
router.post("/validation/cc/stress", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    scenarios: z.array(z.object({
      kind: z.string().min(1),
      perturbedExpectancyR: z.number(),
      description: z.string().optional(),
    })),
    failDegradationPct01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = runStressValidation(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_STRESS_VALIDATED" as never,
    severity: sevForScore(result.score01),
    payload: {
      candidateId: body.candidateId,
      worstScenarioKind: result.worstScenarioKind,
      worstDegradationPct01: result.worstDegradationPct01,
      scenariosFailed: result.scenariosFailed,
      score01: result.score01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Execution Reality ────────────────────────────────────────────────────
router.post("/validation/cc/execution-reality", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    expectancyR: z.number(),
    slippageImpactR: z.number().nonnegative(),
    spreadImpactR: z.number().nonnegative(),
    latencyImpactR: z.number().nonnegative(),
    fillProbability01: z.number().min(0).max(1),
    implementationShortfallR: z.number().nonnegative(),
    brokerReliability01: z.number().min(0).max(1),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessExecutionReality(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_EXECUTION_REALITY_ASSESSED" as never,
    severity: sevForScore(result.score01, result.restrictions.length),
    payload: {
      candidateId: body.candidateId,
      netExpectancyR: result.netExpectancyR,
      shortfallPctOfExpectancy01: result.shortfallPctOfExpectancy01,
      restrictions: result.restrictions,
      score01: result.score01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Trader Behavior Safety ───────────────────────────────────────────────
router.post("/validation/cc/trader-behavior", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    afterLossExpectancyR: z.number(),
    afterOverrideExpectancyR: z.number(),
    overtradingScore01: z.number().min(0).max(1),
    disciplineImpactScore01: z.number().min(0).max(1),
    cognitiveRiskSensitivity01: z.number().min(0).max(1),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessTraderBehaviorSafety(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_TRADER_BEHAVIOR_VALIDATED" as never,
    severity: sevForScore(result.score01, result.restrictions.length),
    payload: {
      candidateId: body.candidateId,
      afterLossDegradationPct01: result.afterLossDegradationPct01,
      afterOverrideDegradationPct01: result.afterOverrideDegradationPct01,
      restrictions: result.restrictions,
      score01: result.score01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Edge Durability ──────────────────────────────────────────────────────
router.post("/validation/cc/edge-durability", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    recentExpectancyR: z.number(),
    baselineExpectancyR: z.number(),
    regimeDriftScore01: z.number().min(0).max(1),
    falseApprovalTrendDeltaPct01: z.number().min(-1).max(1),
    falseBlockTrendDeltaPct01: z.number().min(-1).max(1),
    calibrationDriftDeltaPct01: z.number().min(-1).max(1),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessEdgeDurability(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_EDGE_DURABILITY_ASSESSED" as never,
    severity: result.decayLevel === "SEVERE" ? "CRITICAL"
            : result.decayLevel === "DECAYING" ? "DANGER"
            : result.decayLevel === "MILD" ? "WARN" : "INFO",
    payload: {
      candidateId: body.candidateId,
      decayLevel: result.decayLevel,
      decayPct01: result.decayPct01,
      score01: result.score01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Confidence ───────────────────────────────────────────────────────────
router.post("/validation/cc/confidence", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    statisticalConfidenceScore01: z.number().min(0).max(1),
    regimeFitScore01: z.number().min(0).max(1),
    edgeDurabilityScore01: z.number().min(0).max(1),
    monteCarloRobustness01: z.number().min(0).max(1),
    outOfSampleScore01: z.number().min(0).max(1),
    sampleSize: z.int().nonnegative(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = computeValidationConfidence(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_CONFIDENCE_COMPUTED" as never,
    severity: sevForScore(result.score01),
    payload: {
      candidateId: body.candidateId,
      score01: result.score01,
      weakest: result.weakestComponent,
      strongest: result.strongestComponent,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Scorecard ────────────────────────────────────────────────────────────
const ScorecardBody = z.object({
  candidateId: z.string().min(1),
  edgeQuality01: z.number().min(0).max(1),
  riskSurvival01: z.number().min(0).max(1),
  statisticalReliability01: z.number().min(0).max(1),
  marketRegimeFit01: z.number().min(0).max(1),
  executionReality01: z.number().min(0).max(1),
  traderBehaviorSafety01: z.number().min(0).max(1),
  edgeDurability01: z.number().min(0).max(1),
  passThreshold01: z.number().min(0).max(1).optional(),
}).strict();
router.post("/validation/cc/scorecard", async (req: Request, res: Response) => {
  let body: z.infer<typeof ScorecardBody>;
  try { body = ScorecardBody.parse(req.body); } catch (err) { return fail(res, err); }
  const result = buildValidationScorecard(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_SCORECARD_BUILT" as never,
    severity: result.passed ? "INFO" : sevForScore(result.overallScore01),
    payload: {
      candidateId: body.candidateId,
      overallScore01: result.overallScore01,
      passed: result.passed,
      dimensionsPassed: result.dimensionsPassed,
      dimensionsTotal: result.dimensionsTotal,
      weakestDimension: result.weakestDimension,
      failingDimensions: result.failingDimensions,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Command Center Decision ──────────────────────────────────────────────
// Accepts every sub-engine's RESULT shape (the routes above produce them).
const StatSigResultSchema = z.object({
  expectancyR: z.number(), sampleStddevR: z.number(),
  tStatistic: z.number(), pValueOneSided01: z.number(),
  confidenceLow95R: z.number(), confidenceHigh95R: z.number(),
  sampleAdequacy01: z.number(), overfittingRiskHint01: z.number(),
  score01: z.number(), reasons: z.array(z.string()),
}).passthrough();
const MCResultSchema = z.object({
  simulations: z.int(), medianFinalR: z.number(), meanFinalR: z.number(),
  p05FinalR: z.number(), p95FinalR: z.number(), worstDrawdownR: z.number(),
  ruinProbability01: z.number(), robustness01: z.number(),
  score01: z.number(), reasons: z.array(z.string()),
}).passthrough();
const RegimeFitResultSchema = z.object({
  perRegime: z.record(z.string(), z.unknown()),
  regimesEvaluated: z.array(z.string()),
  regimesPassing: z.array(z.string()),
  regimeFit01: z.number(),
  label: z.enum(["BROAD", "REGIME_SPECIFIC", "NARROW", "INSUFFICIENT_DATA"]),
  score01: z.number(), restrictions: z.array(z.string()), reasons: z.array(z.string()),
}).passthrough();
const ExecRealityResultSchema = z.object({
  netExpectancyR: z.number(), totalImpactR: z.number(),
  shortfallPctOfExpectancy01: z.number(),
  fillProbability01: z.number(), brokerReliability01: z.number(),
  score01: z.number(), restrictions: z.array(z.string()), reasons: z.array(z.string()),
}).passthrough();
const TraderBehaviorResultSchema = z.object({
  baselineExpectancyR: z.number(),
  afterLossDegradationPct01: z.number(),
  afterOverrideDegradationPct01: z.number(),
  score01: z.number(), restrictions: z.array(z.string()), reasons: z.array(z.string()),
}).passthrough();
const EdgeDurabilityResultSchema = z.object({
  decayLevel: z.enum(["STABLE", "MILD", "DECAYING", "SEVERE"]),
  decayPct01: z.number(), expectancyGapPct01: z.number(),
  score01: z.number(), reasons: z.array(z.string()),
}).passthrough();
const OOSResultSchema = z.object({
  ratio: z.number(), oosPassing: z.boolean(),
  overfittingProbability01: z.number(),
  oosNet: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]),
  score01: z.number(), reasons: z.array(z.string()),
}).passthrough();
const ScorecardResultSchema = z.object({
  dimensions: z.array(z.object({
    name: z.string(), score01: z.number(), passed: z.boolean(), weight: z.number(),
  })),
  overallScore01: z.number(),
  dimensionsPassed: z.int(),
  dimensionsTotal: z.int(),
  passed: z.boolean(),
  weakestDimension: z.string(),
  failingDimensions: z.array(z.string()),
  reasons: z.array(z.string()),
}).passthrough();
const StressResultSchema = z.object({
  baselineExpectancyR: z.number(),
  scenarios: z.array(z.unknown()),
  worstScenarioKind: z.string(),
  worstExpectancyR: z.number(),
  worstDegradationPct01: z.number(),
  scenariosFailed: z.array(z.string()),
  scenariosPassed: z.array(z.string()),
  score01: z.number(),
  reasons: z.array(z.string()),
}).passthrough();

router.post("/validation/cc/decision", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    currentStage: ValidationStageSchema,
    liveReadinessScore01: z.number().min(0).max(1),
    ready: z.boolean(),
    frozen: z.boolean(),
    controlTowerAuthorized: z.boolean(),
    scorecard: ScorecardResultSchema,
    edgeDurability: EdgeDurabilityResultSchema,
    monteCarlo: MCResultSchema,
    outOfSample: OOSResultSchema,
    executionReality: ExecRealityResultSchema,
    traderBehavior: TraderBehaviorResultSchema,
    regimeFit: RegimeFitResultSchema,
    statisticalSignificance: StatSigResultSchema,
    stress: StressResultSchema.optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = decideValidationCommandCenter({
    candidateId: body.candidateId,
    currentStage: body.currentStage,
    liveReadinessScore01: body.liveReadinessScore01,
    ready: body.ready, frozen: body.frozen,
    controlTowerAuthorized: body.controlTowerAuthorized,
    scorecard: body.scorecard as ScorecardResult,
    edgeDurability: body.edgeDurability as EdgeDurabilityResult,
    monteCarlo: body.monteCarlo as MonteCarloResult,
    outOfSample: body.outOfSample as OutOfSampleResult,
    executionReality: body.executionReality as ExecutionRealityResult,
    traderBehavior: body.traderBehavior as TraderBehaviorResult,
    regimeFit: body.regimeFit as RegimeFitResult,
    statisticalSignificance: body.statisticalSignificance as StatisticalSignificanceResult,
    stress: body.stress as StressResult | undefined,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_DECISION" as never,
    severity:
        result.decision === "RETIRE" ? "CRITICAL"
      : result.decision === "FREEZE" || result.decision === "DEMOTE" ? "DANGER"
      : result.decision === "RESTRICT" || result.decision === "HOLD" ? "WARN"
      : "INFO",
    payload: {
      candidateId: result.candidateId,
      currentStage: result.currentStage,
      recommendedStage: result.recommendedStage,
      decision: result.decision,
      promotionDecision: result.promotionDecision,
      demotionDecision: result.demotionDecision,
      restrictions: result.restrictions,
      blockers: result.blockers,
      reasonsHead: result.reasons.slice(0, 8),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Audit Report ─────────────────────────────────────────────────────────
const CommandCenterResultSchema = z.object({
  candidateId: z.string(),
  currentStage: ValidationStageSchema,
  recommendedStage: ValidationStageSchema,
  decision: z.enum(["PROMOTE", "HOLD", "RESTRICT", "DEMOTE", "FREEZE", "RETIRE"]),
  promotionDecision: z.enum(["PROMOTE", "DENY"]),
  demotionDecision: z.enum(["NONE", "STEP_BACK", "SHADOW_RESET", "RETIRE"]),
  restrictions: z.array(z.string()),
  liveReadinessScore01: z.number(),
  edgeDurabilityScore01: z.number(),
  survivalScore01: z.number(),
  executionRealityScore01: z.number(),
  statisticalConfidenceScore01: z.number(),
  regimeFitScore01: z.number(),
  traderBehaviorSafetyScore01: z.number(),
  overfittingRiskScore01: z.number(),
  scorecardScore01: z.number(),
  plainEnglishExplanation: z.string(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
}).passthrough();

router.post("/validation/cc/audit-report", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    asOfIso: z.string(),
    command: CommandCenterResultSchema,
    scorecard: ScorecardResultSchema,
    monteCarlo: MCResultSchema.optional(),
    outOfSample: OOSResultSchema.optional(),
    edgeDurability: EdgeDurabilityResultSchema.optional(),
    regimeFit: RegimeFitResultSchema.optional(),
    executionReality: ExecRealityResultSchema.optional(),
    traderBehavior: TraderBehaviorResultSchema.optional(),
    statisticalSignificance: StatSigResultSchema.optional(),
    stress: StressResultSchema.optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const report = buildValidationAuditReport({
    candidateId: body.candidateId,
    asOfIso: body.asOfIso,
    command: body.command as CommandCenterResult,
    scorecard: body.scorecard as ScorecardResult,
    monteCarlo: body.monteCarlo as MonteCarloResult | undefined,
    outOfSample: body.outOfSample as OutOfSampleResult | undefined,
    edgeDurability: body.edgeDurability as EdgeDurabilityResult | undefined,
    regimeFit: body.regimeFit as RegimeFitResult | undefined,
    executionReality: body.executionReality as ExecutionRealityResult | undefined,
    traderBehavior: body.traderBehavior as TraderBehaviorResult | undefined,
    statisticalSignificance: body.statisticalSignificance as StatisticalSignificanceResult | undefined,
    stress: body.stress as StressResult | undefined,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_CC_AUDIT_REPORT_GENERATED" as never,
    severity:
        report.decision === "RETIRE" ? "CRITICAL"
      : report.decision === "FREEZE" || report.decision === "DEMOTE" ? "DANGER"
      : report.decision === "RESTRICT" || report.decision === "HOLD" ? "WARN"
      : "INFO",
    payload: {
      candidateId: report.candidateId,
      asOfIso: report.asOfIso,
      currentStage: report.currentStage,
      recommendedStage: report.recommendedStage,
      decision: report.decision,
      restrictions: report.restrictions,
      blockers: report.blockers,
      timelineCount: report.timeline.length,
    },
  });
  res.json({ ok: true, ...ADVISORY, report });
});

export default router;
