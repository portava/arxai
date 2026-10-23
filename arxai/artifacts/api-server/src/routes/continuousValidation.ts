// ═══════════════════════════════════════════════════════════════════════════
// /api/continuous/* — Continuous Validation + Immune System routes.
//
// All endpoints are ADVISORY (canPlaceTrades:false, mode:VALIDATION_PIPELINE)
// and write a vault event so the Black Box Vault has a permanent record.
//
// Vault events:
//   CV_CONFIDENCE_HEALTH_ASSESSED
//   CV_STRATEGY_TRUST_UPDATED
//   CV_LIVE_SANITY_CHECK
//   CV_EVIDENCE_DECAY_COMPUTED
//   CV_STRATEGY_QUARANTINE_TRANSITION
//   CV_VALIDATION_MEMORY_SUMMARIZED
//   CV_SYSTEM_HEALTH_ASSESSED
//   CV_META_VALIDATION_ASSESSED
//   CV_HEARTBEAT_DECISION
//
// /continuous/heartbeat (master) accepts ONLY raw inputs and recomputes
// every sub-result server-side via the pure engines, mirroring the
// architect-flagged anti-bypass pattern from /adversarial/validate.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  assessConfidenceHealth,
  updateStrategyTrust,
  liveSanityCheck,
  decayEvidence,
  evolveStrategyQuarantine,
  summarizeValidationMemory,
  assessSystemHealth,
  assessMetaValidation,
  runContinuousValidation,
} from "@workspace/domain/continuous-validation";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "VALIDATION_PIPELINE" as never;
const ADVISORY = { canPlaceTrades: false as const, mode: "VALIDATION_PIPELINE" as const };

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}

// ── Reusable schemas ────────────────────────────────────────────────────────
const ConfidencePairShape = z.object({
  predictedConfidence01: z.number().min(0).max(1),
  realizedOutcome01:     z.number().min(0).max(1),
}).strict();

const ConfidenceHealthInputSchema = z.object({
  candidateId: z.string().min(1),
  recent: z.array(ConfidencePairShape),
  baseline: z.array(ConfidencePairShape).optional(),
  unreliableCalibrationErr01: z.number().min(0).max(1).optional(),
  overconfidenceThreshold01:  z.number().min(0).max(1).optional(),
  driftThreshold01:           z.number().min(0).max(1).optional(),
}).strict();

const StrategyTrustInputSchema = z.object({
  candidateId: z.string().min(1),
  priorTrust01: z.number().min(0).max(1),
  recentExpectancyR: z.number(),
  baselineExpectancyR: z.number(),
  recentDrawdownR: z.number().nonnegative(),
  drawdownLimitR:  z.number().nonnegative(),
  robustnessScore01: z.number().min(0).max(1),
  recentOverrideRate01: z.number().min(0).max(1),
  recentSanityFailures: z.int().nonnegative(),
  confidenceHealthScore01: z.number().min(0).max(1),
  maxChangePerCall01: z.number().min(0).max(1).optional(),
}).strict();

const LiveSanityCheckInputSchema = z.object({
  candidateId: z.string().min(1),
  killSwitchEngaged: z.boolean(),
  spreadActual: z.number().nonnegative(),
  spreadExpected: z.number().nonnegative(),
  spreadMaxMultiple: z.number().positive().optional(),
  latencyMs: z.number().nonnegative(),
  latencyMaxMs: z.number().nonnegative().optional(),
  fillProbability01: z.number().min(0).max(1),
  fillProbabilityMin01: z.number().min(0).max(1).optional(),
  openPositions: z.int().nonnegative(),
  maxOpenPositions: z.int().nonnegative(),
  dataFreshnessMs: z.number().nonnegative(),
  maxDataAgeMs: z.number().nonnegative().optional(),
  brokerHealthScore01: z.number().min(0).max(1),
  brokerHealthMin01: z.number().min(0).max(1).optional(),
  regimeMatch: z.boolean(),
  accountEquity: z.number(),
  riskPerTradeR: z.number().nonnegative(),
  riskPerTradeMaxR: z.number().nonnegative().optional(),
  isQuarantined: z.boolean(),
}).strict();

const EvidenceItemShape = z.object({
  kind: z.string().min(1),
  ageHours: z.number().nonnegative(),
  weight: z.number().nonnegative(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).strict();
const EvidenceDecayInputSchema = z.object({
  candidateId: z.string().min(1),
  items: z.array(EvidenceItemShape),
  halfLifeHours: z.number().positive().optional(),
}).strict();

const StrategyQuarantineInputSchema = z.object({
  candidateId: z.string().min(1),
  currentState: z.enum(["NONE", "SHADOW", "RESTRICTED", "RETIRED"]),
  trustScore01: z.number().min(0).max(1),
  severeBreachCount: z.int().nonnegative(),
  moderateConcernCount: z.int().nonnegative(),
  recoveryEvidenceScore01: z.number().min(0).max(1),
  trustRestrictedBelow01: z.number().min(0).max(1).optional(),
  trustShadowBelow01: z.number().min(0).max(1).optional(),
  recoveryThreshold01: z.number().min(0).max(1).optional(),
  recoveryTrustMin01: z.number().min(0).max(1).optional(),
}).strict();

const ValidationMemoryEventShape = z.object({
  eventKind: z.enum(["FAILURE", "DEGRADATION", "RECOVERY"]),
  failureKind: z.string().optional(),
  severity01: z.number().min(0).max(1),
  ageHours: z.number().nonnegative(),
}).strict();
const ValidationMemoryInputSchema = z.object({
  candidateId: z.string().min(1),
  events: z.array(ValidationMemoryEventShape),
  halfLifeHours: z.number().positive().optional(),
  recurrenceMinCount: z.int().positive().optional(),
  persistentRiskMinAvgSeverity01: z.number().min(0).max(1).optional(),
}).strict();

const SystemHealthInputSchema = z.object({
  activeStrategies: z.int().nonnegative(),
  quarantinedStrategies: z.int().nonnegative(),
  dataFreshnessOk: z.boolean(),
  brokerOk: z.boolean(),
  executionLatencyMsP95: z.number().nonnegative(),
  vaultBacklogEvents: z.int().nonnegative(),
  criticalAlertsLast24h: z.int().nonnegative(),
  latencyHealthyMs: z.number().nonnegative().optional(),
  latencyDegradedMs: z.number().nonnegative().optional(),
  vaultBacklogDegraded: z.int().nonnegative().optional(),
  vaultBacklogCritical: z.int().nonnegative().optional(),
  criticalAlertsCritical: z.int().nonnegative().optional(),
}).strict();

const MetaValidationInputSchema = z.object({
  windowDays: z.number().positive(),
  trueApprovals: z.int().nonnegative(),
  falseApprovals: z.int().nonnegative(),
  trueBlocks: z.int().nonnegative(),
  falseBlocks: z.int().nonnegative(),
  tightenAboveFalseApprovalRate01: z.number().min(0).max(1).optional(),
  loosenAboveFalseBlockRate01: z.number().min(0).max(1).optional(),
}).strict();

// ── Per-engine endpoints ────────────────────────────────────────────────────

router.post("/continuous/confidence-health", async (req: Request, res: Response) => {
  let body; try { body = ConfidenceHealthInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessConfidenceHealth(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_CONFIDENCE_HEALTH_ASSESSED" as never,
    severity: result.status === "UNRELIABLE" ? "CRITICAL"
            : result.status === "OVERCONFIDENT" ? "DANGER"
            : result.status === "DRIFTING" ? "WARN" : "INFO",
    payload: {
      candidateId: body.candidateId,
      status: result.status,
      healthScore01: result.healthScore01,
      calibrationError01: result.calibrationError01,
      overconfidence01: result.overconfidence01,
      drift01: result.drift01,
      sampleSize: result.sampleSize,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/strategy-trust", async (req: Request, res: Response) => {
  let body; try { body = StrategyTrustInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = updateStrategyTrust(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_STRATEGY_TRUST_UPDATED" as never,
    severity: result.trustGrade === "F" ? "CRITICAL"
            : result.trustGrade === "D" ? "DANGER"
            : result.trustGrade === "C" ? "WARN" : "INFO",
    payload: {
      candidateId: body.candidateId,
      trustScore01: result.trustScore01,
      trustChange: result.trustChange,
      trustGrade: result.trustGrade,
      contributingFactors: result.contributingFactors,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/live-sanity-check", async (req: Request, res: Response) => {
  let body; try { body = LiveSanityCheckInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = liveSanityCheck(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_LIVE_SANITY_CHECK" as never,
    severity: result.severity,
    payload: {
      candidateId: body.candidateId,
      allow: result.allow,
      blockers: result.blockers,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/evidence-decay", async (req: Request, res: Response) => {
  let body; try { body = EvidenceDecayInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = decayEvidence(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_EVIDENCE_DECAY_COMPUTED" as never,
    severity: result.decayedRatio01 < 0.3 ? "WARN" : "INFO",
    payload: {
      candidateId: body.candidateId,
      itemCount: result.items.length,
      totalRawWeight: result.totalRawWeight,
      totalDecayedWeight: result.totalDecayedWeight,
      decayedRatio01: result.decayedRatio01,
      halfLifeHours: result.halfLifeHours,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/strategy-quarantine", async (req: Request, res: Response) => {
  let body; try { body = StrategyQuarantineInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = evolveStrategyQuarantine(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_STRATEGY_QUARANTINE_TRANSITION" as never,
    severity: result.nextState === "RETIRED" ? "CRITICAL"
            : result.nextState === "RESTRICTED" ? "DANGER"
            : result.nextState === "SHADOW" ? "WARN" : "INFO",
    payload: {
      candidateId: body.candidateId,
      previousState: result.previousState,
      nextState: result.nextState,
      direction: result.direction,
      permissions: result.permissions,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/validation-memory", async (req: Request, res: Response) => {
  let body; try { body = ValidationMemoryInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = summarizeValidationMemory(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_VALIDATION_MEMORY_SUMMARIZED" as never,
    severity: result.persistentRiskFactors.length >= 2 ? "DANGER"
            : result.persistentRiskFactors.length === 1 ? "WARN" : "INFO",
    payload: {
      candidateId: body.candidateId,
      totalFailures: result.totalFailures,
      totalDegradations: result.totalDegradations,
      totalRecoveries: result.totalRecoveries,
      recoveryRate01: result.recoveryRate01,
      recurringFailureKinds: result.recurringFailureKinds,
      persistentRiskFactors: result.persistentRiskFactors,
      trustPenalty01: result.trustPenalty01,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/system-health", async (req: Request, res: Response) => {
  let body; try { body = SystemHealthInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessSystemHealth(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_SYSTEM_HEALTH_ASSESSED" as never,
    severity: result.status === "CRITICAL" ? "CRITICAL"
            : result.status === "DEGRADED" ? "DANGER"
            : result.status === "STRESSED" ? "WARN" : "INFO",
    payload: {
      systemHealthScore01: result.systemHealthScore01,
      status: result.status,
      factors: result.factors,
      recommendations: result.recommendations,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

router.post("/continuous/meta-validation", async (req: Request, res: Response) => {
  let body; try { body = MetaValidationInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessMetaValidation(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_META_VALIDATION_ASSESSED" as never,
    severity: result.calibrationGrade === "F" ? "CRITICAL"
            : result.calibrationGrade === "D" ? "DANGER"
            : result.calibrationGrade === "C" ? "WARN" : "INFO",
    payload: {
      windowDays: result.windowDays,
      precision01: result.precision01,
      recall01: result.recall01,
      falseApprovalRate01: result.falseApprovalRate01,
      falseBlockRate01: result.falseBlockRate01,
      totalDecisions: result.totalDecisions,
      calibrationGrade: result.calibrationGrade,
      recommendation: result.recommendation,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Master Heartbeat ────────────────────────────────────────────────────────
//
// Hardening (architect lessons from /adversarial/validate):
//   • Accepts ONLY raw inputs for every sub-engine; we recompute server-side.
//     This makes it impossible to forge a healthy `trustScore01` or
//     suppress a quarantine state to coerce CONTINUE.
//   • Every sub-input is REQUIRED — no sparse-input bypass. liveSanityCheck
//     remains optional (it represents an immediate pre-trade context).
router.post("/continuous/heartbeat", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    confidenceHealth: ConfidenceHealthInputSchema,
    strategyTrust:    StrategyTrustInputSchema,
    quarantine:       StrategyQuarantineInputSchema,
    memory:           ValidationMemoryInputSchema,
    systemHealth:     SystemHealthInputSchema,
    metaValidation:   MetaValidationInputSchema,
    // Required (architect-flagged): without sanity context the heartbeat
    // could miss live blockers; without evidence decay the strategy's
    // memory-base could be entirely stale. Both must be present.
    liveSanityCheck:  LiveSanityCheckInputSchema,
    evidenceDecay:    EvidenceDecayInputSchema,
    staleEvidenceRatioBelow01: z.number().min(0).max(1).optional(),
  }).strict();

  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  // Recompute every sub-result server-side from raw inputs.
  const ch  = assessConfidenceHealth(body.confidenceHealth);
  const ed  = decayEvidence(body.evidenceDecay);
  // Cross-engine anti-forgery: trust uses the recomputed confidence-health
  // score, never the caller-supplied one. A caller cannot inject a healthy
  // confidence number to lift a struggling strategy's trust.
  const tr  = updateStrategyTrust({
    ...body.strategyTrust,
    confidenceHealthScore01: ch.healthScore01,
  });
  const qr  = evolveStrategyQuarantine(body.quarantine);
  const mem = summarizeValidationMemory(body.memory);
  const sh  = assessSystemHealth(body.systemHealth);
  const mv  = assessMetaValidation(body.metaValidation);
  const lsc = liveSanityCheck(body.liveSanityCheck);

  const result = runContinuousValidation({
    candidateId: body.candidateId,
    trust: tr,
    confidenceHealth: ch,
    systemHealth: sh,
    quarantine: qr,
    memory: mem,
    metaValidation: mv,
    liveSanityCheck: lsc,
    evidenceDecay: ed,
    staleEvidenceRatioBelow01: body.staleEvidenceRatioBelow01,
  });

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "CV_HEARTBEAT_DECISION" as never,
    severity:
        result.verdict === "FREEZE_SYSTEM" ? "CRITICAL"
      : result.verdict === "RETIRE"        ? "CRITICAL"
      : result.verdict === "QUARANTINE"    ? "DANGER"
      : result.verdict === "RESTRICT"      ? "WARN"
      : "INFO",
    payload: {
      candidateId: result.candidateId,
      verdict: result.verdict,
      permissions: result.permissions,
      immuneAlerts: result.immuneAlerts,
      inputs: result.inputs,
      reasonsHead: result.reasons.slice(0, 8),
    },
  });

  res.json({ ok: true, ...ADVISORY, result });
});

export default router;
