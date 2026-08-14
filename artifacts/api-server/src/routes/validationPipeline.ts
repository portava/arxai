// ═══════════════════════════════════════════════════════════════════════════
// /api/validation/* — Phase 7: Validation Pipeline.
//
// Nothing earns live authority without passing every stage. Each endpoint is
// advisory (canPlaceTrades:false, mode:"VALIDATION_PIPELINE") and emits a
// vault event so the Black Box Vault has a permanent audit trail of every
// validation decision, promotion, demotion, freeze, readiness score, and
// generated report.
//
// Vault events:
//   VALIDATION_BACKTEST_RUN, VALIDATION_WALK_FORWARD_RUN,
//   VALIDATION_SHADOW_MODE_EVALUATED, VALIDATION_PAPER_TRADE_EVALUATED,
//   VALIDATION_MICRO_LOT_EVALUATED, VALIDATION_LIMITED_LIVE_EVALUATED,
//   LIVE_READINESS_SCORED, PROMOTION_DECISION, DEMOTION_DECISION,
//   VALIDATION_PIPELINE_RUN, VALIDATION_REPORT_GENERATED.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  StageMetricsSchema, CandidateStateSchema, StageValidationResultSchema,
  type StageValidationResult, type CandidateState, type ValidationLogEntry,
  type ValidationStage,
  validateBacktest, validateWalkForward, validateShadowMode,
  validatePaperTrading, validateMicroLot, validateLimitedLive,
  computeLiveReadinessScore, type CrossSystemSignals,
  checkDemotion, DEFAULT_DEMOTION_TUNING,
  checkAgainstCriteria, DEFAULT_PROMOTION_CRITERIA, toStageResult,
  applyStageResult, promote, checkDemotionAndApply,
  initCandidateState, type PipelinePorts,
  buildValidationReport,
} from "@workspace/domain/validation-pipeline";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "VALIDATION_PIPELINE" as never;
const ADVISORY = { canPlaceTrades: false as const, mode: "VALIDATION_PIPELINE" as const };

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}
function severityForVerdict(v: string): "INFO" | "WARN" | "DANGER" | "CRITICAL" {
  switch (v) {
    case "PASS":         return "INFO";
    case "INCONCLUSIVE": return "WARN";
    case "FROZEN":       return "DANGER";
    case "FAIL":         return "DANGER";
    default:             return "WARN";
  }
}
function severityForReadiness(score01: number, ready: boolean): "INFO" | "WARN" | "DANGER" | "CRITICAL" {
  if (ready) return "INFO";
  if (score01 >= 0.5) return "WARN";
  if (score01 >= 0.25) return "DANGER";
  return "CRITICAL";
}

async function logResult(
  eventType: string,
  result: StageValidationResult,
  extras?: Record<string, unknown>,
): Promise<void> {
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: eventType as never,
    severity: severityForVerdict(result.verdict),
    payload: {
      candidateId: result.candidateId,
      stage: result.stage,
      verdict: result.verdict,
      failedChecks: result.failedChecks,
      sampleSize: result.metrics.trades,
      reasonsHead: result.reasons.slice(0, 6),
      blockers: result.blockers,
      ...(extras ?? {}),
    },
  });
}

// ── Common readiness body shape (cross-system signals optional) ────────────
const CrossSystemSchema = z.object({
  replayLab: z.object({
    survivalScore01:    z.number().min(0).max(1).optional(),
    sampleConfidence01: z.number().min(0).max(1).optional(),
  }).optional(),
  executionIntel: z.object({
    executionQuality01: z.number().min(0).max(1).optional(),
  }).optional(),
  traderDNA: z.object({
    disciplineScore01:    z.number().min(0).max(1).optional(),
    behaviorRiskScore01:  z.number().min(0).max(1).optional(),
  }).optional(),
  cognitive: z.object({
    cognitiveLoad01: z.number().min(0).max(1).optional(),
  }).optional(),
}).strict();

// ═══════════════════════════════════════════════════════════════════════════
// Per-stage validators
// ═══════════════════════════════════════════════════════════════════════════

router.post("/validation/backtest", async (req: Request, res: Response) => {
  let body: { metrics: z.infer<typeof StageMetricsSchema>; recordedAtIso: string };
  try {
    body = z.object({
      metrics: StageMetricsSchema,
      recordedAtIso: z.string(),
    }).strict().parse(req.body);
  } catch (err) { return fail(res, err); }
  const result = validateBacktest(body.metrics, body.recordedAtIso);
  await logResult("VALIDATION_BACKTEST_RUN", result);
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/validation/walk-forward", async (req: Request, res: Response) => {
  let body: { metrics: z.infer<typeof StageMetricsSchema>; recordedAtIso: string };
  try {
    body = z.object({
      metrics: StageMetricsSchema,
      recordedAtIso: z.string(),
    }).strict().parse(req.body);
  } catch (err) { return fail(res, err); }
  const result = validateWalkForward(body.metrics, body.recordedAtIso);
  await logResult("VALIDATION_WALK_FORWARD_RUN", result, {
    folds: body.metrics.foldExpectancyRs?.length ?? 0,
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/validation/shadow-mode", async (req: Request, res: Response) => {
  const Body = z.object({
    metrics: StageMetricsSchema,
    actuallyExecutedTrades: z.int().nonnegative(),
    liveAgreementRate01: z.number().min(0).max(1).optional(),
    recordedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = validateShadowMode(body.metrics,
    { actuallyExecutedTrades: body.actuallyExecutedTrades,
      liveAgreementRate01: body.liveAgreementRate01 },
    body.recordedAtIso);
  await logResult("VALIDATION_SHADOW_MODE_EVALUATED", result, {
    actuallyExecutedTrades: body.actuallyExecutedTrades,
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/validation/paper-trade", async (req: Request, res: Response) => {
  const Body = z.object({
    metrics: StageMetricsSchema,
    realOrdersPlaced: z.int().nonnegative(),
    recordedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = validatePaperTrading(body.metrics,
    { realOrdersPlaced: body.realOrdersPlaced }, body.recordedAtIso);
  await logResult("VALIDATION_PAPER_TRADE_EVALUATED", result, {
    realOrdersPlaced: body.realOrdersPlaced,
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/validation/micro-lot", async (req: Request, res: Response) => {
  const Body = z.object({
    metrics: StageMetricsSchema,
    maxObservedLots: z.number().nonnegative(),
    maxAllowedLots:  z.number().positive(),
    recordedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = validateMicroLot(body.metrics,
    { maxObservedLots: body.maxObservedLots, maxAllowedLots: body.maxAllowedLots },
    body.recordedAtIso);
  await logResult("VALIDATION_MICRO_LOT_EVALUATED", result, {
    maxObservedLots: body.maxObservedLots, maxAllowedLots: body.maxAllowedLots,
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/validation/limited-live", async (req: Request, res: Response) => {
  const Body = z.object({
    metrics: StageMetricsSchema,
    maxObservedExposureR:    z.number().nonnegative(),
    maxAllowedExposureR:     z.number().positive(),
    maxObservedDailyTrades:  z.int().nonnegative(),
    maxAllowedDailyTrades:   z.int().positive(),
    maxObservedDailyRiskR:   z.number().nonnegative(),
    maxAllowedDailyRiskR:    z.number().positive(),
    recordedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = validateLimitedLive(body.metrics, body, body.recordedAtIso);
  await logResult("VALIDATION_LIMITED_LIVE_EVALUATED", result);
  res.json({ ok: true, ...ADVISORY, result });
});

// ═══════════════════════════════════════════════════════════════════════════
// Live readiness — cross-system signals (Replay Lab, Execution Intelligence,
// Trader DNA, Cognitive Risk) blend into the composite when supplied.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/validation/readiness", async (req: Request, res: Response) => {
  const Body = z.object({
    state: CandidateStateSchema,
    stageResults: z.array(StageValidationResultSchema),
    readyThreshold01: z.number().min(0).max(1).optional(),
    crossSystem: CrossSystemSchema.optional(),
    crossSystemWeight01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const score = computeLiveReadinessScore({
    state: body.state, stageResults: body.stageResults,
    readyThreshold01: body.readyThreshold01,
    crossSystem: body.crossSystem as CrossSystemSignals | undefined,
    crossSystemWeight01: body.crossSystemWeight01,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "LIVE_READINESS_SCORED" as never,
    severity: severityForReadiness(score.score01, score.ready),
    payload: {
      candidateId: score.candidateId,
      currentStage: body.state.currentStage,
      score01: score.score01, ready: score.ready,
      perStage01: score.perStage01,
      reasonsHead: score.reasons.slice(0, 8),
      blockers: score.blockers,
      crossSystemUsed: !!body.crossSystem,
    },
  });
  res.json({ ok: true, ...ADVISORY, readiness: score });
});

// ═══════════════════════════════════════════════════════════════════════════
// Promotion / demotion decisions (advisory). PROMOTE goes through the same
// engine that enforces single-step + freeze invariants; the route exposes
// a Risk Governor and Control Tower stub via flags in the body so it stays
// self-contained.
// ═══════════════════════════════════════════════════════════════════════════
function buildVaultLogPort(): PipelinePorts["emitVaultLog"] {
  return async (entry: ValidationLogEntry) => {
    await shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: ("VALIDATION_PIPELINE_LOG_" + entry.kind) as never,
      severity: "INFO",
      payload: {
        entryId: entry.entryId,
        candidateId: entry.candidateId,
        stage: entry.stage,
        kind: entry.kind,
        reasonsHead: entry.reasons.slice(0, 6),
        recordedAtIso: entry.recordedAtIso,
      },
    });
  };
}
function buildPorts(opts: {
  riskGovernorFrozen?: boolean; freezeReason?: string;
  controlTowerAuthorized?: boolean; controlTowerReason?: string;
}): PipelinePorts {
  return {
    riskGovernor: {
      isFrozen: () => !!opts.riskGovernorFrozen,
      freezeReason: () => opts.freezeReason,
    },
    controlTower: {
      authorizeTransition: () => ({
        authorized: opts.controlTowerAuthorized !== false,
        reason: opts.controlTowerReason ?? "default-authorize",
      }),
    },
    emitVaultLog: buildVaultLogPort(),
    newEntryId: () => `vp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

router.post("/validation/promote", async (req: Request, res: Response) => {
  const Body = z.object({
    state: CandidateStateSchema,
    recordedAtIso: z.string(),
    riskGovernorFrozen: z.boolean().optional(),
    freezeReason: z.string().optional(),
    controlTowerAuthorized: z.boolean().optional(),
    controlTowerReason: z.string().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const ports = buildPorts(body);
  const promotion = await promote(body.state as CandidateState, ports, body.recordedAtIso);

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "PROMOTION_DECISION" as never,
    severity: promotion.promoted ? "INFO" : (promotion.blockers.length ? "DANGER" : "WARN"),
    payload: {
      candidateId: promotion.candidateId,
      fromStage: promotion.fromStage, toStage: promotion.toStage,
      promoted: promotion.promoted, authorized: promotion.authorized,
      reasonsHead: promotion.reasons.slice(0, 6),
      blockers: promotion.blockers,
    },
  });
  res.json({ ok: true, ...ADVISORY, promotion });
});

router.post("/validation/demote", async (req: Request, res: Response) => {
  const Body = z.object({
    state: CandidateStateSchema,
    metrics: StageMetricsSchema,
    recordedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const ports = buildPorts({});
  const r = await checkDemotionAndApply(body.state as CandidateState,
    body.metrics, ports, body.recordedAtIso);

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DEMOTION_DECISION" as never,
    severity: r.demotion.shouldDemote ? "DANGER" : "INFO",
    payload: {
      candidateId: r.demotion.candidateId,
      shouldDemote: r.demotion.shouldDemote,
      triggers: r.demotion.triggers,
      proposedStage: r.demotion.proposedStage,
      newCurrentStage: r.newState.currentStage,
      reasonsHead: r.demotion.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, demotion: r.demotion, newState: r.newState });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline orchestrator — applies a stage result and (if PASS) attempts
// promotion gated by Risk Governor + Control Tower stubs from the body.
// Strictly single-stage; the engine refuses multi-step jumps structurally.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/validation/pipeline", async (req: Request, res: Response) => {
  const Body = z.object({
    state: CandidateStateSchema,
    result: StageValidationResultSchema,
    recordedAtIso: z.string(),
    riskGovernorFrozen: z.boolean().optional(),
    freezeReason: z.string().optional(),
    controlTowerAuthorized: z.boolean().optional(),
    controlTowerReason: z.string().optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  const ports = buildPorts(body);
  const out = await applyStageResult(body.state as CandidateState,
    body.result, ports, body.recordedAtIso);

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_PIPELINE_RUN" as never,
    severity: severityForVerdict(body.result.verdict),
    payload: {
      candidateId: body.state.candidate.candidateId,
      fromStage: body.state.currentStage,
      verdict: body.result.verdict,
      promoted: out.promotion?.promoted ?? false,
      newStage: out.newState.currentStage,
      authorized: out.promotion?.authorized ?? false,
      blockers: out.promotion?.blockers ?? [],
    },
  });

  res.json({ ok: true, ...ADVISORY,
    newState: out.newState,
    promotion: out.promotion ?? null });
});

// ═══════════════════════════════════════════════════════════════════════════
// Validation Report — explainable summary of where a candidate stands.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/validation/report", async (req: Request, res: Response) => {
  const DemotionLite = z.object({
    candidateId: z.string(),
    shouldDemote: z.boolean(),
    triggers: z.array(z.string()),
    proposedStage: z.string(),
    reasons: z.array(z.string()),
    blockers: z.array(z.string()),
  }).passthrough();
  const Body = z.object({
    state: CandidateStateSchema,
    stageResults: z.array(StageValidationResultSchema),
    readiness: z.object({
      candidateId: z.string(),
      score01: z.number(),
      perStage01: z.record(z.string(), z.number()),
      ready: z.boolean(),
      reasons: z.array(z.string()),
      blockers: z.array(z.string()),
    }).passthrough(),
    latestDemotionCheck: DemotionLite.nullable().optional(),
    generatedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  // buildValidationReport is pure and tolerant of permissive shapes — cast.
  // The route validates the gross shape; engine is the source of truth.
  const report = buildValidationReport({
    state: body.state as CandidateState,
    stageResults: body.stageResults as StageValidationResult[],
    readiness: body.readiness as Parameters<typeof buildValidationReport>[0]["readiness"],
    latestDemotionCheck: (body.latestDemotionCheck ?? null) as Parameters<typeof buildValidationReport>[0]["latestDemotionCheck"],
    generatedAtIso: body.generatedAtIso,
  });

  const sev: "INFO" | "WARN" | "DANGER" | "CRITICAL" =
      report.recommendation === "RETIRE" ? "CRITICAL"
    : report.recommendation === "FREEZE" ? "DANGER"
    : report.recommendation === "DEMOTE" ? "DANGER"
    : report.recommendation === "PROMOTE" ? "INFO"
    : "WARN";

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "VALIDATION_REPORT_GENERATED" as never,
    severity: sev,
    payload: {
      candidateId: report.candidateId,
      currentStage: report.currentStage,
      recommendation: report.recommendation,
      readinessScore01: report.readiness.score01,
      ready: report.readiness.ready,
      frozen: report.frozen,
      summary: report.summary,
      reasonsHead: report.reasons.slice(0, 8),
      blockers: report.blockers,
    },
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// ═══════════════════════════════════════════════════════════════════════════
// Helper: initialize a candidate state. Convenience for tests/UI.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/validation/init-candidate", async (req: Request, res: Response) => {
  const Body = z.object({
    candidate: z.object({
      candidateId: z.string().min(1).max(128),
      kind: z.enum(["STRATEGY", "AGENT", "RULE", "AI_BEHAVIOR"]),
      refId: z.string().min(1),
      versionId: z.string().min(1),
      introducedAtIso: z.string(),
    }),
    recordedAtIso: z.string(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const state = initCandidateState(body.candidate, body.recordedAtIso);
  res.json({ ok: true, ...ADVISORY, state });
});

// Re-export silence for unused-warnings purity (these are referenced by
// downstream callers via the index export).
void checkDemotion; void DEFAULT_DEMOTION_TUNING;
void checkAgainstCriteria; void DEFAULT_PROMOTION_CRITERIA; void toStageResult;
void ([] as ValidationStage[]);

export default router;
