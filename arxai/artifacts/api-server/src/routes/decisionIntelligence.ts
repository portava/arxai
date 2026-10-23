// ═══════════════════════════════════════════════════════════════════════════
// /api/decision/* — Phase 8 Decision Intelligence Layer.
//
// All endpoints are ADVISORY (canPlaceTrades:false, mode:DECISION_PIPELINE).
// Risk Governor and Control Tower remain above this layer; nothing here
// places trades. Every decision is vault-logged with DI_* event types.
//
// Stance:
//   • A winning trade is not automatically a good decision.
//   • A losing trade is not automatically a bad decision.
//   • No-trade decisions can be scored as successful.
//   • Conviction controls aggression, size, hold time, monitoring intensity.
//   • Strategic Patience can recommend WAIT / MONITOR_ONLY / SOFT_BLOCK / HARD_BLOCK.
//   • Future Risk Simulation must test dangerous scenarios before approval.
//   • Decision Chain Scoring grades the full sequence, not just the outcome.
//
// /decision/evaluate (master) accepts ONLY raw inputs and recomputes every
// sub-result server-side via the pure engines, mirroring the anti-bypass
// pattern from /continuous/heartbeat.
//
// Vault events emitted:
//   DI_DECISION_QUALITY_SCORED
//   DI_EXPECTANCY_COMPUTED
//   DI_CONVICTION_REPORTED
//   DI_PATIENCE_ASSESSED
//   DI_FUTURE_RISK_SIMULATED
//   DI_MARKET_PERSONALITY_PROFILED
//   DI_ADAPTIVE_AGGRESSION_RECOMMENDED
//   DI_NO_TRADE_QUALITY_SCORED
//   DI_DECISION_CHAIN_SCORED
//   DI_DECISION_INTELLIGENCE_VERDICT
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  scoreDecisionQuality,
  computeExpectancy,
  computeConvictionReport,
  computePatienceMetrics,
  recommendPatienceMode,
  computeFatigueState,
  profileMarketPersonality,
  simulateFutureRisk,
  recommendAggression,
  scoreNoTradeQuality,
  scoreDecisionChain,
  type DecisionRecord,
  type SimulationResult,
  SimulationResultSchema,
  // Governance (Phase 8 upgrade)
  runDecisionGovernance,
  derivePermission,
  deriveAggressionLimit,
  deriveSizingMultiplier,
  derivePolicy,
  applyOverrides,
  type GovernanceOverride,
} from "@workspace/domain/decision-intelligence";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "DECISION_PIPELINE" as never;
const ADVISORY = { canPlaceTrades: false as const, mode: "DECISION_PIPELINE" as const };

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}

// ── Reusable schemas ────────────────────────────────────────────────────────
const DecisionRecordSchema = z.object({
  decisionId: z.string().min(1).max(128),
  strategyId: z.string().min(1).max(128),
  symbolId:   z.string().min(1).max(64),
  kind: z.enum(["ENTRY","EXIT","SCALE_IN","SCALE_OUT","HOLD","NO_TRADE","BLOCKED"]),
  takenAtIso: z.string(),
  session: z.enum(["ASIA","LONDON","NEW_YORK","OVERLAP_LDN_NY","AFTER_HOURS"]),
  regime: z.enum(["TREND_UP","TREND_DOWN","RANGE","EXPANSION","COMPRESSION","HIGH_VOL","LOW_VOL","CRASH","ANY"]),
  followedRules: z.boolean(),
  riskSizingCorrect: z.boolean(),
  preTradeChecklistPassed: z.boolean(),
  futureRiskSimApproved: z.boolean(),
  expressedConfidence01: z.number().min(0).max(1),
  convictionGrade01: z.number().min(0).max(1),
  outcome: z.enum(["WIN","LOSS","BREAKEVEN","AVOIDED_LOSS","MISSED_WIN","PENDING","N_A"]),
  realizedR: z.number().optional(),
  notes: z.string().optional(),
}).strict();

const SimulationInputSchema = z.object({
  candidateRiskR: z.number().nonnegative(),
  expectancyR: z.number(),
  winRate01: z.number().min(0).max(1),
  avgWinR: z.number(),
  avgLossR: z.number(),
  pathsToSimulate: z.int().positive().max(100_000).default(1000),
  horizonTrades: z.int().positive().max(10_000).default(100),
  ruinThresholdR: z.number().negative().default(-30),
  seed: z.int().nonnegative().default(1),
}).strict();

const PersonalityInputSchema = z.object({
  trendStrength01: z.number().min(0).max(1),
  rangeBound01: z.number().min(0).max(1),
  autocorr1: z.number().min(-1).max(1),
  realisedVolZ: z.number(),
  volumeBurstZ: z.number(),
  microNoiseRatio01: z.number().min(0).max(1),
  dominantThreshold: z.number().min(0).max(1).optional(),
}).strict();

const FatigueInputSchema = z.object({
  decisionsLastHour: z.number().nonnegative(),
  errorsLastHour: z.number().nonnegative(),
  minutesSinceLastBreak: z.number().nonnegative(),
}).strict();

// ── 1. Decision Quality ─────────────────────────────────────────────────────
router.post("/decision/quality", async (req: Request, res: Response) => {
  const Body = z.object({
    decision: DecisionRecordSchema,
    counterfactualR: z.number().optional(),
    simulationProof: SimulationResultSchema.optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const result = scoreDecisionQuality({
    decision: body.decision,
    counterfactualR: body.counterfactualR,
    simulationProof: body.simulationProof as SimulationResult | undefined,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_DECISION_QUALITY_SCORED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 2. Expectancy ───────────────────────────────────────────────────────────
router.post("/decision/expectancy", async (req: Request, res: Response) => {
  const Body = z.object({
    records: z.array(DecisionRecordSchema),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const result = computeExpectancy({ records: body.records });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_EXPECTANCY_COMPUTED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 3. Conviction ───────────────────────────────────────────────────────────
router.post("/decision/conviction", async (req: Request, res: Response) => {
  const Body = z.object({
    records: z.array(DecisionRecordSchema),
    bandCount: z.int().min(2).max(20).optional(),
    overconfidenceTolerance: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const result = computeConvictionReport(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_CONVICTION_REPORTED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 4. Strategic Patience ───────────────────────────────────────────────────
router.post("/decision/patience", async (req: Request, res: Response) => {
  const Body = z.object({
    records: z.array(DecisionRecordSchema),
    qualifiedSetupsCount: z.int().nonnegative(),
    waitMinutesByDecisionId: z.record(z.string(), z.number().nonnegative()).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const waitMap = body.waitMinutesByDecisionId
    ? new Map(Object.entries(body.waitMinutesByDecisionId))
    : undefined;
  const result = computePatienceMetrics({
    records: body.records,
    qualifiedSetupsCount: body.qualifiedSetupsCount,
    waitMinutesByDecisionId: waitMap,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_PATIENCE_ASSESSED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 5. Future Risk Simulation ───────────────────────────────────────────────
router.post("/decision/future-risk", async (req: Request, res: Response) => {
  let body: z.infer<typeof SimulationInputSchema>;
  try { body = SimulationInputSchema.parse(req.body); } catch (err) { return fail(res, err); }

  const result = simulateFutureRisk(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_FUTURE_RISK_SIMULATED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 6. Market Personality ───────────────────────────────────────────────────
router.post("/decision/market-personality", async (req: Request, res: Response) => {
  let body: z.infer<typeof PersonalityInputSchema>;
  try { body = PersonalityInputSchema.parse(req.body); } catch (err) { return fail(res, err); }

  const result = profileMarketPersonality(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_MARKET_PERSONALITY_PROFILED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 7. Adaptive Aggression ──────────────────────────────────────────────────
//
// Anti-bypass: takes RAW inputs (records + market personality + fatigue
// inputs) and recomputes conviction/expectancy/fatigue server-side. Caller
// cannot fabricate a high-calibration ConvictionReport to inflate aggression.
router.post("/decision/adaptive-aggression", async (req: Request, res: Response) => {
  const Body = z.object({
    records: z.array(DecisionRecordSchema),
    market: PersonalityInputSchema,
    fatigue: FatigueInputSchema,
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const conviction = computeConvictionReport({ records: body.records });
  const expectancy = computeExpectancy({ records: body.records });
  const fatigue = computeFatigueState(body.fatigue);
  const market = profileMarketPersonality(body.market);
  const result = recommendAggression({ conviction, expectancy, fatigue, market });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_ADAPTIVE_AGGRESSION_RECOMMENDED" as never,
    severity: "INFO",
    payload: { input: body, recomputed: { conviction, expectancy, fatigue, market }, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 8. No-Trade Quality ─────────────────────────────────────────────────────
//
// Anti-bypass: takes RAW inputs and recomputes market/patience/expectancy
// from raw records. Caller cannot pre-cook a "patience" object.
router.post("/decision/no-trade-quality", async (req: Request, res: Response) => {
  const Body = z.object({
    decision: DecisionRecordSchema,
    counterfactualR: z.number().optional(),
    historyRecords: z.array(DecisionRecordSchema),
    qualifiedSetupsCount: z.int().nonnegative(),
    market: PersonalityInputSchema,
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const market = profileMarketPersonality(body.market);
  const patience = computePatienceMetrics({
    records: body.historyRecords,
    qualifiedSetupsCount: body.qualifiedSetupsCount,
  });
  const expectancy = computeExpectancy({ records: body.historyRecords });
  const result = scoreNoTradeQuality({
    decision: body.decision,
    counterfactualR: body.counterfactualR,
    market, patience, expectancy,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_NO_TRADE_QUALITY_SCORED" as never,
    severity: "INFO",
    payload: { input: body, recomputed: { market, patience, expectancy }, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── 9. Decision Chain Scoring ───────────────────────────────────────────────
router.post("/decision/chain", async (req: Request, res: Response) => {
  const Body = z.object({
    chainId: z.string().min(1),
    steps: z.array(DecisionRecordSchema).min(1),
    simulationProofs: z.record(z.string(), SimulationResultSchema).optional(),
    counterfactualsR: z.record(z.string(), z.number()).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const result = scoreDecisionChain({
    chainId: body.chainId,
    steps: body.steps,
    simulationProofs: body.simulationProofs as Record<string, SimulationResult> | undefined,
    counterfactualsR: body.counterfactualsR,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_DECISION_CHAIN_SCORED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

// ── MASTER. /decision/evaluate ──────────────────────────────────────────────
//
// Single endpoint that recomputes EVERY sub-result from raw inputs and
// returns the unified Decision Intelligence verdict with a recommendedAction.
//
// Anti-bypass invariants:
//   • Every sub-engine input is REQUIRED and recomputed server-side.
//   • futureRiskSim is recomputed here and passed as VERIFIED proof to
//     decisionQuality and patience-mode — caller's self-reported sim flag
//     and a forged simulationProof are both ignored at this endpoint.
//   • Patience-mode HARD_BLOCK overrides any other recommendation.
//
// Decision priority for `recommendedAction`:
//   patienceMode === HARD_BLOCK              → HARD_BLOCK
//   patienceMode === SOFT_BLOCK              → SOFT_BLOCK
//   patienceMode === MONITOR_ONLY            → MONITOR_ONLY
//   patienceMode === WAIT                    → WAIT
//   decisionQuality.qualityScore01 < PUNISH  → SOFT_BLOCK
//   aggression.level === CONSERVATIVE        → PROCEED_REDUCED
//   else                                     → PROCEED
router.post("/decision/evaluate", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateDecision: DecisionRecordSchema,
    historyRecords: z.array(DecisionRecordSchema),
    qualifiedSetupsCount: z.int().nonnegative(),
    market: PersonalityInputSchema,
    fatigue: FatigueInputSchema,
    simulation: SimulationInputSchema,
    counterfactualR: z.number().optional(),
    chainSteps: z.array(DecisionRecordSchema).optional(),
    chainId: z.string().min(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  // Recompute every sub-result server-side.
  const expectancy = computeExpectancy({ records: body.historyRecords });
  const conviction = computeConvictionReport({ records: body.historyRecords });
  const patience = computePatienceMetrics({
    records: body.historyRecords,
    qualifiedSetupsCount: body.qualifiedSetupsCount,
  });
  const fatigueState = computeFatigueState(body.fatigue);
  const market = profileMarketPersonality(body.market);
  const sim = simulateFutureRisk(body.simulation);
  const aggression = recommendAggression({
    conviction, expectancy, fatigue: fatigueState, market,
  });
  const patienceRec = recommendPatienceMode({
    patience, market, expectancy, fatigue: fatigueState, simulationProof: sim,
  });
  const decisionQuality = scoreDecisionQuality({
    decision: body.candidateDecision,
    counterfactualR: body.counterfactualR,
    simulationProof: sim,   // recomputed proof, not caller-supplied
  });
  const isRestraint =
    body.candidateDecision.kind === "NO_TRADE"
    || body.candidateDecision.kind === "BLOCKED";
  const noTradeQuality = isRestraint
    ? scoreNoTradeQuality({
        decision: body.candidateDecision,
        counterfactualR: body.counterfactualR,
        market, patience, expectancy,
      })
    : null;
  const chain = (body.chainSteps && body.chainSteps.length > 0)
    ? scoreDecisionChain({
        chainId: body.chainId ?? body.candidateDecision.decisionId,
        steps: body.chainSteps,
        simulationProofs: { [body.candidateDecision.decisionId]: sim },
        counterfactualsR: body.counterfactualR !== undefined
          ? { [body.candidateDecision.decisionId]: body.counterfactualR }
          : undefined,
      })
    : null;

  // Decision priority for recommendedAction.
  type Action =
    | "HARD_BLOCK" | "SOFT_BLOCK" | "MONITOR_ONLY" | "WAIT"
    | "PROCEED_REDUCED" | "PROCEED";
  let recommendedAction: Action;
  const reasons: string[] = [];
  if (patienceRec.mode === "HARD_BLOCK") {
    recommendedAction = "HARD_BLOCK";
    reasons.push(`patience HARD_BLOCK — ${patienceRec.blockers.join("; ") || patienceRec.reasons[0]}`);
  } else if (patienceRec.mode === "SOFT_BLOCK") {
    recommendedAction = "SOFT_BLOCK";
    reasons.push(`patience SOFT_BLOCK — negative expectancy`);
  } else if (patienceRec.mode === "MONITOR_ONLY") {
    recommendedAction = "MONITOR_ONLY";
    reasons.push(`patience MONITOR_ONLY — frenzy/noisy market`);
  } else if (patienceRec.mode === "WAIT") {
    recommendedAction = "WAIT";
    reasons.push(`patience WAIT — noisy market`);
  } else if (decisionQuality.qualityScore01 < 0.40) {
    recommendedAction = "SOFT_BLOCK";
    reasons.push(`decisionQuality ${decisionQuality.qualityScore01.toFixed(2)} below PUNISH threshold`);
  } else if (aggression.level === "CONSERVATIVE") {
    recommendedAction = "PROCEED_REDUCED";
    reasons.push(`aggression CONSERVATIVE — reduce size`);
  } else {
    recommendedAction = "PROCEED";
    reasons.push(`all clear — proceed at ${aggression.level} (×${aggression.multiplier})`);
  }

  const verdict = {
    candidateId: body.candidateDecision.decisionId,
    recommendedAction,
    scores: {
      decisionQualityScore01: decisionQuality.qualityScore01,
      expectancyScore01:      expectancy.expectancyQuality01,
      convictionScore01:      conviction.overallCalibration01,
      patienceScore01:        patience.patienceScore01,
      survivalImpactScore01:  expectancy.survivalQuality01,
      futureRiskScore01:      sim.approved ? 1 - sim.ruinProbability01 : 0,
      noTradeQualityScore01:  noTradeQuality?.qualityScore01 ?? null,
      chainQualityScore01:    chain?.chainQualityScore01 ?? null,
    },
    aggression,
    patienceRecommendation: patienceRec,
    decisionQuality,
    noTradeQuality,
    chain,
    simulation: sim,
    reasons,
    plainEnglishExplanation: buildPlainEnglish(
      recommendedAction, decisionQuality.classification,
      patienceRec.mode, aggression.level, sim.approved,
    ),
  };

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_DECISION_INTELLIGENCE_VERDICT" as never,
    severity: "INFO",
    payload: { input: body, verdict },
  });
  res.json({ ...ADVISORY, verdict });
});

function buildPlainEnglish(
  action: string, classification: string, patienceMode: string,
  aggression: string, simApproved: boolean,
): string {
  const head =
    action === "HARD_BLOCK"      ? "Do NOT trade — a hard safety rule was triggered."
    : action === "SOFT_BLOCK"    ? "Hold off — current conditions or process quality don't support a trade."
    : action === "MONITOR_ONLY"  ? "Watch only — observe but do not enter; conditions are too unstable."
    : action === "WAIT"          ? "Wait briefly — market is noisy; let it settle."
    : action === "PROCEED_REDUCED" ? "Proceed at reduced size — caution warranted."
    : "Proceed normally — all process gates clear.";
  const tail = ` (classification: ${classification}, patience: ${patienceMode}, aggression: ${aggression}, simApproved: ${simApproved})`;
  return head + tail;
}

// ═══════════════════════════════════════════════════════════════════════════
// Decision Governance (Phase 8 upgrade)
//
// Converts Decision Intelligence sub-results into ENFORCEABLE limits:
//   • allowedPermissionLevel
//   • maxAggressionLevel
//   • maxPositionSize     (in R)
//   • requiredConfirmation
//   • requiredDelay       (seconds)
//   • recommendedAction
//   • reason
//
// Anti-bypass: /decision/governance is the ONLY governance entry point.
// It accepts RAW inputs (same shape as /decision/evaluate) plus an
// optional `overrides[]` list from Risk Governor / Control Tower /
// Manual Operator. Every sub-result is recomputed server-side and the
// recomputed simulation proof is the only one used.
//
// Risk Governor and Control Tower can MONOTONICALLY RESTRICT the
// governance verdict (lower permission, lower aggression cap, lower
// position size, raise confirmation, raise delay, raise action severity).
// Attempts to RELAX governance are silently ignored and recorded in
// `appliedOverrides` notes.
//
// Vault events:
//   DI_GOV_PERMISSION_DERIVED
//   DI_GOV_AGGRESSION_LIMITED
//   DI_GOV_SIZING_DERIVED
//   DI_GOV_POLICY_DERIVED
//   DI_GOV_OVERRIDES_APPLIED
//   DI_DECISION_GOVERNANCE_VERDICT
// ═══════════════════════════════════════════════════════════════════════════

const PermissionLevelSchemaLocal = z.enum([
  "BLOCKED","OBSERVE_ONLY","REDUCED","STANDARD","FULL",
]);
const AggressionLevelSchemaLocal = z.enum([
  "CONSERVATIVE","STANDARD","ELEVATED","MAX",
]);
const ConfirmationLevelSchemaLocal = z.enum([
  "NONE","SINGLE","DOUBLE","MULTI_STEP",
]);
const GovernanceActionSchemaLocal = z.enum([
  "HARD_BLOCK","SOFT_BLOCK","MONITOR_ONLY","WAIT","PROCEED_REDUCED","PROCEED",
]);
const PatienceModeSchemaLocal = z.enum([
  "PROCEED","WAIT","MONITOR_ONLY","SOFT_BLOCK","HARD_BLOCK",
]);
const GovernanceOverrideSchemaLocal = z.object({
  source: z.enum(["RISK_GOVERNOR","CONTROL_TOWER","MANUAL_OPERATOR"]),
  maxPermissionLevel: PermissionLevelSchemaLocal.optional(),
  maxAggressionLevel: AggressionLevelSchemaLocal.optional(),
  maxPositionSizeR: z.number().nonnegative().optional(),
  minConfirmation: ConfirmationLevelSchemaLocal.optional(),
  minDelaySeconds: z.number().int().nonnegative().optional(),
  forceRecommendedAction: GovernanceActionSchemaLocal.optional(),
  reason: z.string().min(1),
}).strict();

router.post("/decision/governance", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateDecision: DecisionRecordSchema,
    historyRecords: z.array(DecisionRecordSchema),
    qualifiedSetupsCount: z.int().nonnegative(),
    market: PersonalityInputSchema,
    fatigue: FatigueInputSchema,
    simulation: SimulationInputSchema,
    baseRiskR: z.number().nonnegative(),
    counterfactualR: z.number().optional(),
    overrides: z.array(GovernanceOverrideSchemaLocal).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  // Recompute every DI sub-result server-side (anti-bypass).
  const expectancy = computeExpectancy({ records: body.historyRecords });
  const conviction = computeConvictionReport({ records: body.historyRecords });
  const patience = computePatienceMetrics({
    records: body.historyRecords,
    qualifiedSetupsCount: body.qualifiedSetupsCount,
  });
  const fatigueState = computeFatigueState(body.fatigue);
  const market = profileMarketPersonality(body.market);
  const sim = simulateFutureRisk(body.simulation);
  const aggression = recommendAggression({
    conviction, expectancy, fatigue: fatigueState, market,
  });
  const patienceRec = recommendPatienceMode({
    patience, market, expectancy, fatigue: fatigueState, simulationProof: sim,
  });
  const decisionQuality = scoreDecisionQuality({
    decision: body.candidateDecision,
    counterfactualR: body.counterfactualR,
    simulationProof: sim,
  });
  // No-trade scoring is folded into governance output for restraint
  // decisions, so they are positively scored AND logged in the master
  // pipeline (acceptance criterion: "no-trade decisions can be positively
  // scored and logged").
  const isRestraint =
    body.candidateDecision.kind === "NO_TRADE"
    || body.candidateDecision.kind === "BLOCKED";
  const noTradeQuality = isRestraint
    ? scoreNoTradeQuality({
        decision: body.candidateDecision,
        counterfactualR: body.counterfactualR,
        market, patience, expectancy,
      })
    : null;

  const verdict = runDecisionGovernance({
    candidateId: body.candidateDecision.decisionId,
    decisionQuality, expectancy, conviction,
    fatigue: fatigueState, market, simulation: sim,
    aggression, patienceMode: patienceRec.mode,
    baseRiskR: body.baseRiskR,
    overrides: body.overrides as ReadonlyArray<GovernanceOverride> | undefined,
  });

  // Per-stage observability: emit a DI_GOV_* event for each governance
  // sub-result so downstream auditors can reconstruct the pipeline
  // exactly. The master DI_DECISION_GOVERNANCE_VERDICT event then
  // carries the unified envelope.
  const candidateId = body.candidateDecision.decisionId;
  await Promise.all([
    shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "DI_GOV_PERMISSION_DERIVED" as never,
      severity: verdict.permission.allowedPermissionLevel === "BLOCKED" ? "CRITICAL" : "INFO",
      payload: { candidateId, result: verdict.permission },
    }),
    shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "DI_GOV_AGGRESSION_LIMITED" as never,
      severity: "INFO",
      payload: { candidateId, result: verdict.aggressionLimit },
    }),
    shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "DI_GOV_SIZING_DERIVED" as never,
      severity: verdict.sizing.maxPositionSizeR === 0 ? "DANGER" : "INFO",
      payload: { candidateId, result: verdict.sizing },
    }),
    shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "DI_GOV_POLICY_DERIVED" as never,
      severity: verdict.policy.requiredConfirmation === "MULTI_STEP" ? "WARN" : "INFO",
      payload: { candidateId, result: verdict.policy },
    }),
    shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "DI_GOV_OVERRIDES_APPLIED" as never,
      severity: verdict.appliedOverrides.length > 0 ? "WARN" : "INFO",
      payload: { candidateId, applied: verdict.appliedOverrides },
    }),
    isRestraint
      ? shadowCapture({
          source: SOURCE, systemMode: null, globalState: null,
          eventType: "DI_NO_TRADE_QUALITY_SCORED" as never,
          severity: "INFO",
          payload: { candidateId, result: noTradeQuality },
        })
      : Promise.resolve(),
  ]);

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_DECISION_GOVERNANCE_VERDICT" as never,
    severity:
        verdict.recommendedAction === "HARD_BLOCK" ? "CRITICAL"
      : verdict.recommendedAction === "SOFT_BLOCK" ? "DANGER"
      : verdict.recommendedAction === "MONITOR_ONLY" ? "WARN"
      : "INFO",
    payload: {
      input: body, verdict,
      noTradeQuality,
      di: {
        decisionQuality, expectancy, conviction,
        fatigue: fatigueState, market, simulation: sim,
        aggression, patienceMode: patienceRec.mode,
      },
    },
  });

  res.json({ ...ADVISORY, verdict, noTradeQuality });
});

// ── Per-engine governance endpoints (transparency) ─────────────────────────
//
// These accept the already-computed DI sub-results (validated against
// SimulationResultSchema for sim proof, etc.). They do NOT participate in
// the master pipeline; they exist for inspection and unit-style usage.

router.post("/decision/governance/permission", async (req: Request, res: Response) => {
  const Body = z.object({
    decisionQuality: z.object({
      decisionId: z.string().min(1),
      classification: z.string(),
      qualityScore01: z.number().min(0).max(1),
      reinforce: z.boolean(),
      punish: z.boolean(),
      reasons: z.array(z.string()),
      blockers: z.array(z.string()),
    }).passthrough(),
    expectancy: z.object({
      sampleSize: z.int().nonnegative(),
      winRate01: z.number().min(0).max(1),
      avgWinR: z.number(),
      avgLossR: z.number(),
      expectancyR: z.number(),
      expectancyQuality01: z.number().min(0).max(1),
      survivalQuality01: z.number().min(0).max(1),
      optimalRiskFraction01: z.number().min(0).max(1),
      reasons: z.array(z.string()),
    }).passthrough(),
    fatigue: z.object({
      decisionsLastHour: z.int().nonnegative(),
      errorsLastHour: z.int().nonnegative(),
      minutesSinceLastBreak: z.number().nonnegative(),
      fatigueScore01: z.number().min(0).max(1),
      forceCooldown: z.boolean(),
      cooldownMinutes: z.number().nonnegative(),
      reasons: z.array(z.string()),
    }).passthrough(),
    simulation: SimulationResultSchema,
    patienceMode: PatienceModeSchemaLocal,
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = derivePermission(body as Parameters<typeof derivePermission>[0]);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_GOV_PERMISSION_DERIVED" as never,
    severity: result.allowedPermissionLevel === "BLOCKED" ? "CRITICAL" : "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

router.post("/decision/governance/aggression-limit", async (req: Request, res: Response) => {
  // Recompute all four inputs from raw signals so caller can't forge them.
  const Body = z.object({
    historyRecords: z.array(DecisionRecordSchema),
    market: PersonalityInputSchema,
    fatigue: FatigueInputSchema,
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const conviction = computeConvictionReport({ records: body.historyRecords });
  const expectancy = computeExpectancy({ records: body.historyRecords });
  const fatigueState = computeFatigueState(body.fatigue);
  const market = profileMarketPersonality(body.market);
  const aggression = recommendAggression({
    conviction, expectancy, fatigue: fatigueState, market,
  });
  const result = deriveAggressionLimit({
    conviction, aggression, market, fatigue: fatigueState,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_GOV_AGGRESSION_LIMITED" as never,
    severity: "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

router.post("/decision/governance/sizing", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateDecision: DecisionRecordSchema,
    historyRecords: z.array(DecisionRecordSchema),
    market: PersonalityInputSchema,
    fatigue: FatigueInputSchema,
    simulation: SimulationInputSchema,
    baseRiskR: z.number().nonnegative(),
    counterfactualR: z.number().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const conviction = computeConvictionReport({ records: body.historyRecords });
  const expectancy = computeExpectancy({ records: body.historyRecords });
  const fatigueState = computeFatigueState(body.fatigue);
  const market = profileMarketPersonality(body.market);
  const sim = simulateFutureRisk(body.simulation);
  const aggression = recommendAggression({
    conviction, expectancy, fatigue: fatigueState, market,
  });
  const decisionQuality = scoreDecisionQuality({
    decision: body.candidateDecision,
    counterfactualR: body.counterfactualR,
    simulationProof: sim,
  });
  const aggressionLimit = deriveAggressionLimit({
    conviction, aggression, market, fatigue: fatigueState,
  });
  const result = deriveSizingMultiplier({
    baseRiskR: body.baseRiskR, conviction, decisionQuality,
    expectancy, simulation: sim, aggressionLimit,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_GOV_SIZING_DERIVED" as never,
    severity: result.maxPositionSizeR === 0 ? "DANGER" : "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

router.post("/decision/governance/policy", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateDecision: DecisionRecordSchema,
    historyRecords: z.array(DecisionRecordSchema),
    qualifiedSetupsCount: z.int().nonnegative(),
    market: PersonalityInputSchema,
    fatigue: FatigueInputSchema,
    simulation: SimulationInputSchema,
    baseRiskR: z.number().nonnegative(),
    counterfactualR: z.number().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const expectancy = computeExpectancy({ records: body.historyRecords });
  const conviction = computeConvictionReport({ records: body.historyRecords });
  const patience = computePatienceMetrics({
    records: body.historyRecords,
    qualifiedSetupsCount: body.qualifiedSetupsCount,
  });
  const fatigueState = computeFatigueState(body.fatigue);
  const market = profileMarketPersonality(body.market);
  const sim = simulateFutureRisk(body.simulation);
  const aggression = recommendAggression({
    conviction, expectancy, fatigue: fatigueState, market,
  });
  const patienceRec = recommendPatienceMode({
    patience, market, expectancy, fatigue: fatigueState, simulationProof: sim,
  });
  const decisionQuality = scoreDecisionQuality({
    decision: body.candidateDecision,
    counterfactualR: body.counterfactualR, simulationProof: sim,
  });
  const permission = derivePermission({
    decisionQuality, expectancy, fatigue: fatigueState,
    simulation: sim, patienceMode: patienceRec.mode,
  });
  const aggressionLimit = deriveAggressionLimit({
    conviction, aggression, market, fatigue: fatigueState,
  });
  const sizing = deriveSizingMultiplier({
    baseRiskR: body.baseRiskR, conviction, decisionQuality,
    expectancy, simulation: sim, aggressionLimit,
  });
  const result = derivePolicy({
    permission, aggressionLimit, sizing,
    simulation: sim, fatigue: fatigueState,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_GOV_POLICY_DERIVED" as never,
    severity: result.requiredConfirmation === "MULTI_STEP" ? "WARN" : "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

router.post("/decision/governance/overrides", async (req: Request, res: Response) => {
  // Pure: takes already-derived governance components + a set of overrides
  // and returns the post-override result.
  const Body = z.object({
    permission: z.object({
      allowedPermissionLevel: PermissionLevelSchemaLocal,
      reasons: z.array(z.string()),
      blockers: z.array(z.string()),
    }).strict(),
    aggressionLimit: z.object({
      maxAggressionLevel: AggressionLevelSchemaLocal,
      recommendedAggressionLevel: AggressionLevelSchemaLocal,
      maxAggressionMultiplier: z.number().min(0).max(2),
      reasons: z.array(z.string()),
    }).strict(),
    sizing: z.object({
      baseRiskR: z.number().nonnegative(),
      maxPositionSizeR: z.number().nonnegative(),
      appliedMultiplier: z.number().min(0).max(2),
      reasons: z.array(z.string()),
    }).strict(),
    policy: z.object({
      requiredConfirmation: ConfirmationLevelSchemaLocal,
      requiredDelaySeconds: z.number().int().nonnegative(),
      reasons: z.array(z.string()),
    }).strict(),
    recommendedAction: GovernanceActionSchemaLocal,
    overrides: z.array(GovernanceOverrideSchemaLocal),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = applyOverrides(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DI_GOV_OVERRIDES_APPLIED" as never,
    severity: result.appliedOverrides.length > 0 ? "WARN" : "INFO",
    payload: { input: body, result },
  });
  res.json({ ...ADVISORY, result });
});

export default router;
