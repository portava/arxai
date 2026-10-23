// ═══════════════════════════════════════════════════════════════════════════
// /api/adversarial/* — Adversarial Validation routes.
//
// Actively searches for failure conditions across six attack categories
// (edge fragility, regime collapse, execution sabotage, behavioral stress,
// contradiction testing, overfit exposure) plus an assumption audit.
// All endpoints are ADVISORY (canPlaceTrades:false, mode:VALIDATION_PIPELINE)
// and write a vault event so the Black Box Vault has a permanent record.
//
// Vault events:
//   ADVERSARIAL_EDGE_FRAGILITY_ASSESSED
//   ADVERSARIAL_REGIME_COLLAPSE_ASSESSED
//   ADVERSARIAL_EXECUTION_SABOTAGE_ASSESSED
//   ADVERSARIAL_BEHAVIORAL_STRESS_ASSESSED
//   ADVERSARIAL_CONTRADICTION_TOLERANCE_ASSESSED
//   ADVERSARIAL_OVERFIT_EXPOSURE_ASSESSED
//   ADVERSARIAL_ASSUMPTION_AUDIT
//   ADVERSARIAL_ATTACK_BUNDLE
//   ADVERSARIAL_VALIDATION_DECISION
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  assessEdgeFragility,
  assessRegimeCollapse,
  assessExecutionSabotage,
  assessBehavioralStress,
  assessContradictionTolerance,
  assessOverfitExposure,
  auditAssumptions,
  runStrategyAttack,
  decideAdversarialValidation,
} from "@workspace/domain/adversarial-validation";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "VALIDATION_PIPELINE" as never;
const ADVISORY = { canPlaceTrades: false as const, mode: "VALIDATION_PIPELINE" as const };

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}
function sevForFragility(f: number): "INFO" | "WARN" | "DANGER" | "CRITICAL" {
  if (f >= 0.7) return "CRITICAL";
  if (f >= 0.5) return "DANGER";
  if (f >= 0.3) return "WARN";
  return "INFO";
}

// Reused scenario shape: { kind, perturbedExpectancyR, description? }
const ScenarioShape = z.object({
  kind: z.string().min(1),
  perturbedExpectancyR: z.number(),
  description: z.string().optional(),
});
const EdgeAttackShape = ScenarioShape.extend({ magnitude01: z.number().min(0).max(1).optional() });
const ProbeShape = ScenarioShape;

// ── Edge Fragility ───────────────────────────────────────────────────────
router.post("/adversarial/edge-fragility", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    attacks: z.array(EdgeAttackShape),
    failDegradationPct01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessEdgeFragility(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_EDGE_FRAGILITY_ASSESSED" as never,
    severity: sevForFragility(result.fragilityScore01),
    payload: {
      candidateId: body.candidateId,
      fragilityScore01: result.fragilityScore01,
      robustnessScore01: result.robustnessScore01,
      breakingPoints: result.breakingPoints,
      worstAttackKind: result.worstAttackKind,
      worstDegradationPct01: result.worstDegradationPct01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Regime Collapse ──────────────────────────────────────────────────────
router.post("/adversarial/regime-collapse", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    scenarios: z.array(ScenarioShape),
    failDegradationPct01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessRegimeCollapse(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_REGIME_COLLAPSE_ASSESSED" as never,
    severity: sevForFragility(result.fragilityScore01),
    payload: {
      candidateId: body.candidateId,
      fragilityScore01: result.fragilityScore01,
      collapsePoints: result.collapsePoints,
      worstScenarioKind: result.worstScenarioKind,
      worstDegradationPct01: result.worstDegradationPct01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Execution Sabotage ───────────────────────────────────────────────────
router.post("/adversarial/execution-sabotage", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    scenarios: z.array(ScenarioShape),
    failDegradationPct01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessExecutionSabotage(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_EXECUTION_SABOTAGE_ASSESSED" as never,
    severity: sevForFragility(result.fragilityScore01),
    payload: {
      candidateId: body.candidateId,
      fragilityScore01: result.fragilityScore01,
      sabotagePoints: result.sabotagePoints,
      worstScenarioKind: result.worstScenarioKind,
      worstDegradationPct01: result.worstDegradationPct01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Behavioral Stress ────────────────────────────────────────────────────
router.post("/adversarial/behavioral-stress", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    scenarios: z.array(ScenarioShape),
    failDegradationPct01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessBehavioralStress(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_BEHAVIORAL_STRESS_ASSESSED" as never,
    severity: sevForFragility(result.fragilityScore01),
    payload: {
      candidateId: body.candidateId,
      fragilityScore01: result.fragilityScore01,
      stressPoints: result.stressPoints,
      worstScenarioKind: result.worstScenarioKind,
      worstDegradationPct01: result.worstDegradationPct01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Contradiction Tolerance ──────────────────────────────────────────────
router.post("/adversarial/contradiction-test", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    scenarios: z.array(ScenarioShape),
    failDegradationPct01: z.number().min(0).max(1).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessContradictionTolerance(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_CONTRADICTION_TOLERANCE_ASSESSED" as never,
    severity: sevForFragility(result.fragilityScore01),
    payload: {
      candidateId: body.candidateId,
      toleranceScore01: result.toleranceScore01,
      intolerancePoints: result.intolerancePoints,
      worstScenarioKind: result.worstScenarioKind,
      worstDegradationPct01: result.worstDegradationPct01,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Overfit Exposure ─────────────────────────────────────────────────────
router.post("/adversarial/overfit-exposure", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    baselineExpectancyR: z.number(),
    probes: z.array(ProbeShape),
    collapseThresholdPct01: z.number().min(0).max(1).optional(),
    reversedKinds: z.array(z.string()).optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = assessOverfitExposure(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_OVERFIT_EXPOSURE_ASSESSED" as never,
    severity: sevForFragility(result.fragilityScore01),
    payload: {
      candidateId: body.candidateId,
      fragilityScore01: result.fragilityScore01,
      exposurePoints: result.exposurePoints,
      worstProbeKind: result.worstProbeKind,
      reasonsHead: result.reasons.slice(0, 6),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Assumption Audit ─────────────────────────────────────────────────────
router.post("/adversarial/assumption-audit", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    assumptions: z.array(z.object({
      kind: z.string().min(1),
      holds: z.boolean(),
      severity01: z.number().min(0).max(1),
      evidence: z.string().optional(),
      recommendedRestriction: z.string().optional(),
    })),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = auditAssumptions(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_ASSUMPTION_AUDIT" as never,
    severity: sevForFragility(result.violationSeverity01),
    payload: {
      candidateId: body.candidateId,
      assumptionsHolding: result.assumptionsHolding,
      assumptionsViolated: result.assumptionsViolated,
      violationSeverity01: result.violationSeverity01,
      score01: result.score01,
      recommendedRestrictions: result.recommendedRestrictions,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Raw input schemas — used by both /attack and /validate. We never
//    accept caller-computed sub-results: it is too easy to forge a payload
//    that suppresses `breaking` or under-reports fragility and forces a
//    PROMOTE. Instead we always recompute fragility server-side from the
//    raw scenario data using the pure engines.
const EdgeFragilityInputSchema = z.object({
  baselineExpectancyR: z.number(),
  attacks: z.array(EdgeAttackShape),
  failDegradationPct01: z.number().min(0).max(1).optional(),
}).strict();
const ScenarioInputSchema = z.object({
  baselineExpectancyR: z.number(),
  scenarios: z.array(ScenarioShape),
  failDegradationPct01: z.number().min(0).max(1).optional(),
}).strict();
const OverfitInputSchema = z.object({
  baselineExpectancyR: z.number(),
  probes: z.array(ProbeShape),
  collapseThresholdPct01: z.number().min(0).max(1).optional(),
  reversedKinds: z.array(z.string()).optional(),
}).strict();
const AssumptionInputSchema = z.object({
  assumptions: z.array(z.object({
    kind: z.string().min(1),
    holds: z.boolean(),
    severity01: z.number().min(0).max(1),
    evidence: z.string().optional(),
    recommendedRestriction: z.string().optional(),
  }).strict()),
}).strict();

// ── Strategy Attack (run all sub-engines in one call) ────────────────────
router.post("/adversarial/attack", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    edgeFragility:     EdgeFragilityInputSchema.optional(),
    regimeCollapse:    ScenarioInputSchema.optional(),
    executionSabotage: ScenarioInputSchema.optional(),
    behavioralStress:  ScenarioInputSchema.optional(),
    contradictionTest: ScenarioInputSchema.optional(),
    overfitExposure:   OverfitInputSchema.optional(),
    assumptionAudit:   AssumptionInputSchema.optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }
  const result = runStrategyAttack(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_ATTACK_BUNDLE" as never,
    severity: "INFO",
    payload: {
      candidateId: body.candidateId,
      categoriesRun: result.categoriesRun,
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

// ── Master Decision: Adversarial Validation ──────────────────────────────
//
// Hardening notes (architect-flagged invariants):
//   • SPARSE-INPUT BYPASS — a caller could previously submit only one
//     robust category and PROMOTE. /validate now REQUIRES all six attack
//     categories. Sparse input fails closed with 400.
//   • FORGED-RESULT BYPASS — /validate previously accepted caller-computed
//     sub-results (`fragilityScore01`, `breaking`, …). Those fields could
//     be forged to suppress failures. /validate now accepts ONLY raw
//     attack inputs and recomputes every per-category result through the
//     pure engines on the server side before deciding.
router.post("/adversarial/validate", async (req: Request, res: Response) => {
  const Body = z.object({
    candidateId: z.string().min(1),
    // All six attack categories are REQUIRED. There is no way to PROMOTE
    // without proving robustness across every dimension.
    edgeFragility:     EdgeFragilityInputSchema,
    regimeCollapse:    ScenarioInputSchema,
    executionSabotage: ScenarioInputSchema,
    behavioralStress:  ScenarioInputSchema,
    contradictionTest: ScenarioInputSchema,
    overfitExposure:   OverfitInputSchema,
    // Assumption audit is optional but, when present, can also force
    // RESTRICT/blockers via severity ≥ 0.7.
    assumptionAudit:   AssumptionInputSchema.optional(),
  }).strict();
  let body: z.infer<typeof Body>;
  try { body = Body.parse(req.body); } catch (err) { return fail(res, err); }

  // Recompute every sub-result server-side from raw inputs. The caller has
  // no way to influence the engines' breaking/fragility decisions beyond
  // supplying the underlying scenarios.
  const sub = runStrategyAttack(body);
  const result = decideAdversarialValidation({
    candidateId: body.candidateId,
    edgeFragility:     sub.edgeFragility,
    regimeCollapse:    sub.regimeCollapse,
    executionSabotage: sub.executionSabotage,
    behavioralStress:  sub.behavioralStress,
    contradictionTest: sub.contradictionTest,
    overfitExposure:   sub.overfitExposure,
    assumptionAudit:   sub.assumptionAudit,
  });
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ADVERSARIAL_VALIDATION_DECISION" as never,
    severity:
        result.decision === "RETIRE"   ? "CRITICAL"
      : result.decision === "DEMOTE"   ? "DANGER"
      : result.decision === "RESTRICT" ? "WARN"
      : "INFO",
    payload: {
      candidateId: result.candidateId,
      decision: result.decision,
      allowedToPromote: result.allowedToPromote,
      fragilityScore01: result.fragilityScore01,
      robustnessScore01: result.robustnessScore01,
      adversarialFailurePointsCount: result.adversarialFailurePoints.length,
      recommendedRestrictions: result.recommendedRestrictions,
      weakestCategory: result.weakestCategory,
      reasonsHead: result.reasons.slice(0, 8),
    },
  });
  res.json({ ok: true, ...ADVISORY, result });
});

export default router;
