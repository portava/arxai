// ═══════════════════════════════════════════════════════════════════════════
// /api/economy/* — Phase 10 AI Economy + Strategy Lifecycle + Evolution Lab
//                   + Resource Management.
//
// All endpoints are ADVISORY (canPlaceTrades:false). Modes:
//   AI_ECONOMY_PIPELINE | LIFECYCLE_PIPELINE | EVOLUTION_PIPELINE | RESOURCE_PIPELINE
//
// PROJECT GUARANTEES enforced here:
//   • Reputation, trust, lifecycle and evolution outputs are advisory.
//     The downstream Risk Governor / Control Tower pipeline retains final
//     authority over capital and freezes.
//   • Lifecycle FSM rejects skipping stages (12-stage table-driven map).
//   • Evolution mutations only accepted when mode === "SANDBOX".
//   • Vault entries are emitted via shadowCapture for every state change.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { shadowCapture } from "../lib/auditVault.js";
import {
  // Reputation
  ReputationEventSchema, ReputationStateSchema,
  updateReputation, seedReputation,
  StrategyReputationEventSchema, StrategyReputationStateSchema,
  updateStrategyReputation, seedStrategyReputation,
  // Trust score
  TrustInputsSchema, computeTrustScore,
} from "@workspace/domain/ai-economy";
import {
  LifecycleEventSchema, StrategyLifecycleStateSchema,
  transitionLifecycle, seedLifecycle, allowedEventsFrom,
  PromotionInputsSchema, evaluatePromotion,
  DemotionInputsSchema, evaluateDemotion,
  QuarantineInputsSchema, evaluateQuarantine,
  RetirementInputsSchema, evaluateRetirement,
} from "@workspace/domain/strategy-lifecycle";
import {
  EvolutionCycleInputsSchema, runEvolutionCycle,
  buildMutationReport,
} from "@workspace/domain/evolution";
import {
  AttentionBudgetInputsSchema, triageAttention,
  ValidationTaskSchema, rankValidations,
  ReplayCandidateSchema, rankReplayCandidates,
} from "@workspace/domain/resource-management";

const router: IRouter = Router();
const SOURCE = "AI_ECONOMY" as never;

function nowIso(): string { return new Date().toISOString(); }

function envelope(mode: "AI_ECONOMY_PIPELINE" | "LIFECYCLE_PIPELINE" | "EVOLUTION_PIPELINE" | "RESOURCE_PIPELINE") {
  return { canPlaceTrades: false as const, mode, generatedAtIso: nowIso() };
}

function parseOr400<T extends z.ZodTypeAny>(
  schema: T, body: unknown, res: Response,
): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (!r.success) {
    res.status(400).json({ error: "invalid request body", issues: r.error.issues });
    return null;
  }
  return r.data;
}

async function logEvent(
  eventType: string, severity: "INFO" | "WARN" | "DANGER",
  payload: Record<string, unknown>,
): Promise<void> {
  await shadowCapture({
    source: SOURCE,
    eventType: eventType as never,
    severity,
    systemMode: null, globalState: null,
    payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// AI Economy — Agent reputation
// ─────────────────────────────────────────────────────────────────────────
const AgentReputationBody = z.object({
  prev: ReputationStateSchema.nullable(),
  event: ReputationEventSchema,
}).strict();

router.post("/economy/agent-reputation/update", async (req: Request, res: Response) => {
  const body = parseOr400(AgentReputationBody, req.body, res);
  if (!body) return;

  const prev = body.prev ?? seedReputation(body.event.agentId, body.event.observedAtIso);
  if (prev.agentId !== body.event.agentId) {
    res.status(400).json({ error: "agentId mismatch between prev and event" });
    return;
  }
  const result = updateReputation(prev, body.event);
  await logEvent("EC_AGENT_REPUTATION_UPDATED", "INFO", {
    agentId: prev.agentId,
    fromReputation01: prev.reputation01,
    toReputation01: result.next.reputation01,
    eventScore01: result.eventScore01,
  });
  res.json({ ...envelope("AI_ECONOMY_PIPELINE"), result });
});

// ─────────────────────────────────────────────────────────────────────────
// AI Economy — Strategy reputation
// ─────────────────────────────────────────────────────────────────────────
const StrategyReputationBody = z.object({
  prev: StrategyReputationStateSchema.nullable(),
  event: StrategyReputationEventSchema,
}).strict();

router.post("/economy/strategy-reputation/update", async (req: Request, res: Response) => {
  const body = parseOr400(StrategyReputationBody, req.body, res);
  if (!body) return;
  const prev = body.prev ?? seedStrategyReputation(body.event.strategyId, body.event.observedAtIso);
  if (prev.strategyId !== body.event.strategyId) {
    res.status(400).json({ error: "strategyId mismatch between prev and event" });
    return;
  }
  const result = updateStrategyReputation(prev, body.event);
  await logEvent("EC_STRATEGY_REPUTATION_UPDATED", "INFO", {
    strategyId: prev.strategyId,
    fromReputation01: prev.reputation01,
    toReputation01: result.next.reputation01,
    eventScore01: result.eventScore01,
  });
  res.json({ ...envelope("AI_ECONOMY_PIPELINE"), result });
});

// ─────────────────────────────────────────────────────────────────────────
// AI Economy — Trust score (composite, discipline-floored)
// ─────────────────────────────────────────────────────────────────────────
router.post("/economy/trust-score", async (req: Request, res: Response) => {
  const body = parseOr400(TrustInputsSchema, req.body, res);
  if (!body) return;
  const result = computeTrustScore(body);
  await logEvent("EC_TRUST_SCORE_COMPUTED", "INFO", {
    trustScore01: result.score01,
    rawScore01: result.rawScore01,
    confidence01: result.confidence01,
    discipline01: body.discipline01,
    sampleCount: body.sampleCount,
  });
  res.json({ ...envelope("AI_ECONOMY_PIPELINE"), result });
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle — transition (FSM)
// ─────────────────────────────────────────────────────────────────────────
const LifecycleTransitionBody = z.object({
  state: StrategyLifecycleStateSchema.nullable(),
  strategyId: z.string().min(1).optional(),
  event: LifecycleEventSchema,
  reasons: z.array(z.string()).default([]),
}).strict();

router.post("/economy/lifecycle/transition", async (req: Request, res: Response) => {
  const body = parseOr400(LifecycleTransitionBody, req.body, res);
  if (!body) return;
  const at = nowIso();
  const current = body.state ?? seedLifecycle(body.strategyId ?? "unspecified", at);
  const result = transitionLifecycle(current, body.event, at, body.reasons);
  const sev: "INFO" | "WARN" | "DANGER" = result.changed
    ? (result.next.stage === "QUARANTINED" || result.next.stage === "RETIRED" || result.next.stage === "DEGRADED" ? "WARN" : "INFO")
    : "WARN";
  await logEvent("EC_LIFECYCLE_TRANSITION", sev, {
    strategyId: current.strategyId,
    fromStage: current.stage, toStage: result.next.stage,
    event: body.event, changed: result.changed,
    blockers: result.blockers,
  });
  res.json({
    ...envelope("LIFECYCLE_PIPELINE"),
    result,
    allowedEventsFromCurrent: allowedEventsFrom(current.stage),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle — promotion / demotion / quarantine / retirement evaluators
// ─────────────────────────────────────────────────────────────────────────
router.post("/economy/lifecycle/promotion", async (req: Request, res: Response) => {
  const body = parseOr400(PromotionInputsSchema, req.body, res);
  if (!body) return;
  const decision = evaluatePromotion(body);
  await logEvent("EC_PROMOTION_EVALUATED", decision.recommend ? "INFO" : "WARN", {
    strategyId: body.strategyId, fromStage: body.currentStage,
    proposedTargetStage: decision.proposedTargetStage,
    recommend: decision.recommend, failedGates: decision.failedGates,
  });
  res.json({ ...envelope("LIFECYCLE_PIPELINE"), decision });
});

router.post("/economy/lifecycle/demotion", async (req: Request, res: Response) => {
  const body = parseOr400(DemotionInputsSchema, req.body, res);
  if (!body) return;
  const decision = evaluateDemotion(body);
  await logEvent("EC_DEMOTION_EVALUATED", decision.recommend ? "WARN" : "INFO", {
    strategyId: body.strategyId, fromStage: body.currentStage,
    proposedEvent: decision.proposedEvent, triggers: decision.triggers,
  });
  res.json({ ...envelope("LIFECYCLE_PIPELINE"), decision });
});

router.post("/economy/lifecycle/quarantine", async (req: Request, res: Response) => {
  const body = parseOr400(QuarantineInputsSchema, req.body, res);
  if (!body) return;
  const decision = evaluateQuarantine(body);
  await logEvent("EC_QUARANTINE_EVALUATED", decision.recommend ? "DANGER" : "INFO", {
    strategyId: body.strategyId, fromStage: body.currentStage,
    triggers: decision.triggers,
  });
  res.json({ ...envelope("LIFECYCLE_PIPELINE"), decision });
});

router.post("/economy/lifecycle/retirement", async (req: Request, res: Response) => {
  const body = parseOr400(RetirementInputsSchema, req.body, res);
  if (!body) return;
  const decision = evaluateRetirement(body);
  await logEvent("EC_RETIREMENT_EVALUATED", decision.recommend ? "WARN" : "INFO", {
    strategyId: body.strategyId, fromStage: body.currentStage,
    triggers: decision.triggers,
  });
  res.json({ ...envelope("LIFECYCLE_PIPELINE"), decision });
});

// ─────────────────────────────────────────────────────────────────────────
// Evolution — sandbox-only mutation cycle
// ─────────────────────────────────────────────────────────────────────────
const EvolutionCycleBody = EvolutionCycleInputsSchema;

router.post("/economy/evolution/cycle", async (req: Request, res: Response) => {
  const body = parseOr400(EvolutionCycleBody, req.body, res);
  if (!body) return;
  const cycle = runEvolutionCycle(body);
  const report = buildMutationReport(cycle, nowIso(), body.mutation.parentStrategyId);
  const sev: "INFO" | "WARN" | "DANGER" =
    body.mode !== "SANDBOX" ? "DANGER"
    : report.totals.graduatedAtValidation > 0 ? "INFO"
    : "WARN";
  await logEvent("EC_EVOLUTION_CYCLE_RUN", sev, {
    cycleId: cycle.cycleId,
    parentStrategyId: body.mutation.parentStrategyId,
    mode: body.mode,
    variantsGenerated: report.totals.variantsGenerated,
    graduated: report.totals.graduatedAtValidation,
    rejectedAtMode: report.totals.rejectedAtMode,
    blockers: cycle.blockers,
  });
  res.json({ ...envelope("EVOLUTION_PIPELINE"), cycle, report });
});

// ─────────────────────────────────────────────────────────────────────────
// Resource Management — attention budget triage
// ─────────────────────────────────────────────────────────────────────────
router.post("/economy/resource/attention", async (req: Request, res: Response) => {
  const body = parseOr400(AttentionBudgetInputsSchema, req.body, res);
  if (!body) return;
  const result = triageAttention(body);
  await logEvent("EC_ATTENTION_TRIAGED", "INFO", {
    totalBudgetUnits: body.totalBudgetUnits,
    unitsConsumed: result.unitsConsumed,
    attended: result.attendedCount, deferred: result.deferredCount, dropped: result.droppedCount,
  });
  res.json({ ...envelope("RESOURCE_PIPELINE"), result });
});

// ─────────────────────────────────────────────────────────────────────────
// Resource Management — validation queue ranking
// ─────────────────────────────────────────────────────────────────────────
router.post("/economy/resource/validation-priority", async (req: Request, res: Response) => {
  const body = parseOr400(z.object({ tasks: z.array(ValidationTaskSchema) }).strict(), req.body, res);
  if (!body) return;
  const result = rankValidations(body.tasks);
  await logEvent("EC_VALIDATION_QUEUE_RANKED", "INFO", { taskCount: body.tasks.length });
  res.json({ ...envelope("RESOURCE_PIPELINE"), result });
});

// ─────────────────────────────────────────────────────────────────────────
// Resource Management — replay queue ranking
// ─────────────────────────────────────────────────────────────────────────
router.post("/economy/resource/replay-priority", async (req: Request, res: Response) => {
  const body = parseOr400(z.object({ candidates: z.array(ReplayCandidateSchema) }).strict(), req.body, res);
  if (!body) return;
  const result = rankReplayCandidates(body.candidates);
  await logEvent("EC_REPLAY_QUEUE_RANKED", "INFO", { candidateCount: body.candidates.length });
  res.json({ ...envelope("RESOURCE_PIPELINE"), result });
});

export default router;
