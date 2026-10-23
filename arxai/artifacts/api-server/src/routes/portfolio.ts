// ═══════════════════════════════════════════════════════════════════════════
// /api/portfolio/* — Phase 9 Portfolio Manager + Capital Allocation.
//
// All endpoints are ADVISORY (canPlaceTrades:false, mode:PORTFOLIO_PIPELINE).
// Risk Governor and Control Tower remain above this layer; nothing here
// places trades. The plan accepts caller-supplied freeze hints but cannot
// UNFREEZE anything — caller-supplied freezes are honored monotonically.
//
// /portfolio/plan (master) accepts ONLY raw inputs and recomputes every
// sub-result server-side via the pure engines, mirroring the anti-bypass
// pattern from /decision/governance.
//
// Vault events emitted (source PORTFOLIO_MANAGER):
//   PM_RESERVE_DERIVED
//   PM_RISK_BUDGET_DERIVED
//   PM_STRATEGY_ALLOCATION_DERIVED
//   PM_EXPOSURE_BALANCED
//   PM_CONVICTION_ALLOCATED
//   PM_SURVIVAL_ALLOCATED
//   PM_ROTATION_DECIDED
//   PM_SYMBOL_PRIORITIZED
//   PM_SESSION_PRIORITIZED
//   PM_AGENT_AUTHORITY_ALLOCATED
//   PM_OVERRIDE_APPLIED
//   PM_PLAN_GENERATED
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { randomBytes } from "node:crypto";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { computeExposure, detectCorrelationWarnings } from "../lib/portfolio/exposure.js";
import { shadowCapture } from "../lib/auditVault.js";
import { getStatus as getSafetyCoreStatus } from "../lib/safetyCore.js";
import {
  AccountRiskRulesSchema,
  StrategyMetricsSchema,
  SymbolContextSchema,
  SessionContextSchema,
  AgentContextSchema,
  MarketRegimeSchema,
  TradingSessionSchema,
  StrategyAllocationSchema,
  type StrategyAllocation,
  ConvictionInputSchema,
  SurvivalInputSchema,
  EcosystemInputSchema,
  computeEcosystem,
  generateAllocationPlan,
  type PortfolioPorts,
  type PortfolioLogEntry,
  computeReserveFraction,
  computeRiskBudget,
  allocateStrategies,
  balanceExposure,
  computeSymbolPriorities,
  computeSessionPriorities,
  allocateAgentAuthority,
  rotateCapital,
  convictionWeightedAllocation,
  survivalWeightedAllocation,
} from "@workspace/domain/portfolio-manager";

const router: IRouter = Router();

const ADVISORY = { canPlaceTrades: false as const, mode: "PORTFOLIO_PIPELINE" as const };
const SOURCE = "PORTFOLIO_MANAGER" as never;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function nowIso(): string { return new Date().toISOString(); }

// ── Caller-supplied Risk Governor freezes (monotonic; can only restrict) ──
const FreezeHintSchema = z.object({
  account: z.object({ frozen: z.boolean(), reason: z.string().optional() }).optional(),
  strategies: z.array(z.object({
    id: z.string().min(1), reason: z.string().optional(),
  })).optional(),
  agents: z.array(z.object({
    id: z.string().min(1), reason: z.string().optional(),
  })).optional(),
});
type FreezeHint = z.infer<typeof FreezeHintSchema>;

interface AuthoritativeOverride { frozen: boolean; reason: string | null }

function buildPorts(
  freezes: FreezeHint | undefined,
  authoritative: AuthoritativeOverride,
  scopeEvents: PortfolioLogEntry[],
): PortfolioPorts {
  // Authoritative state and caller hints are merged MONOTONICALLY: a freeze
  // from EITHER source freezes the scope. Caller can never UNFREEZE
  // anything the authoritative Risk Governor / Kill Switch has frozen.
  const accountFrozen = authoritative.frozen || !!freezes?.account?.frozen;
  const accountReason = authoritative.frozen
    ? `kill switch engaged: ${authoritative.reason ?? "(unspecified)"}`
    : freezes?.account?.reason;
  const strategySet = new Map<string, string>();
  for (const s of freezes?.strategies ?? []) strategySet.set(s.id, s.reason ?? "(unspecified)");
  const agentSet = new Map<string, string>();
  for (const a of freezes?.agents ?? []) agentSet.set(a.id, a.reason ?? "(unspecified)");

  return {
    riskGovernor: {
      isFrozen(scope, refId) {
        if (scope === "ACCOUNT") return accountFrozen;
        if (scope === "STRATEGY") return strategySet.has(refId);
        if (scope === "AGENT") return agentSet.has(refId);
        return false;
      },
      freezeReason(scope, refId) {
        if (scope === "ACCOUNT") return accountReason;
        if (scope === "STRATEGY") return strategySet.get(refId);
        if (scope === "AGENT") return agentSet.get(refId);
        return undefined;
      },
    },
    emitVaultLog: (entry) => { scopeEvents.push(entry); },
    newEntryId: () => newId("pme"),
    newPlanId:  () => newId("pmp"),
  };
}

// ── Master plan input schema ──────────────────────────────────────────────
const PortfolioPlanBodySchema = z.object({
  rules: AccountRiskRulesSchema,
  strategies: z.array(StrategyMetricsSchema).min(1),
  symbols: z.array(SymbolContextSchema),
  sessions: z.array(SessionContextSchema),
  agents: z.array(AgentContextSchema),
  activeRegime: MarketRegimeSchema,
  activeSession: TradingSessionSchema,
  regimeUncertainty01: z.number().min(0).max(1),
  accountDrawdownFraction01: z.number().min(0).max(1),
  conviction: z.array(ConvictionInputSchema).optional(),
  survival: z.array(SurvivalInputSchema).optional(),
  ecosystem: EcosystemInputSchema.optional(),
  freezes: FreezeHintSchema.optional(),
}).strict();

// Standalone ecosystem-only request — no allocation, just the climate /
// efficiency / fatigue / competition / health report.
const EcosystemBodySchema = z.object({
  strategies: z.array(StrategyMetricsSchema).min(1),
  agents: z.array(AgentContextSchema).default([]),
  regimeUncertainty01: z.number().min(0).max(1),
  accountDrawdownFraction01: z.number().min(0).max(1),
  baseReserveFraction01: z.number().min(0).max(1).default(0.2),
  totalDeployedR: z.number().nonnegative().default(0),
  deployableR: z.number().positive(),
  perSymbolRiskR: z.record(z.string(), z.number().nonnegative()).default({}),
  perStrategyRiskR: z.record(z.string(), z.number().nonnegative()).default({}),
  perSessionRiskR: z.record(z.string(), z.number().nonnegative()).default({}),
  ecosystem: EcosystemInputSchema.optional(),
}).strict();

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
// Legacy routes — kept for backwards compatibility with existing UI/tests.
// ─────────────────────────────────────────────────────────────────────────
// Portfolio QA P1: previously queried ALL trades globally → cross-tenant leak.
// Now requireUser + filter by req.authUser.id. Legacy NULL-userId rows are
// intentionally excluded (eq() does not match NULL) — surfacing legacy global
// rows to any user would be a worse leak than hiding them.
router.get("/portfolio/exposure", requireUser, async (req, res) => {
  const trades = await db.select().from(tradesTable)
    .where(eq(tradesTable.userId, req.authUser!.id));
  res.json(computeExposure(trades));
});

router.get("/portfolio/correlation-warnings", requireUser, async (req, res) => {
  const trades = await db.select().from(tradesTable)
    .where(eq(tradesTable.userId, req.authUser!.id));
  res.json(detectCorrelationWarnings(trades));
});

// ─────────────────────────────────────────────────────────────────────────
// Master /portfolio/plan
// ─────────────────────────────────────────────────────────────────────────
router.post("/portfolio/plan", async (req: Request, res: Response) => {
  const body = parseOr400(PortfolioPlanBodySchema, req.body, res);
  if (!body) return;

  // Consult AUTHORITATIVE Risk Governor / Kill Switch state. The plan
  // cannot bypass it: if the kill switch is engaged, the account is
  // treated as frozen no matter what the caller supplied.
  let authoritative: AuthoritativeOverride = { frozen: false, reason: null };
  try {
    const sc = await getSafetyCoreStatus();
    authoritative = {
      frozen: !!sc.killSwitchEngaged,
      reason: sc.killSwitchReason ?? null,
    };
  } catch (err) {
    // Fail-closed: if we cannot reach the safety core, FREEZE the plan
    // to be safe — the alternative is silently producing an unfrozen plan.
    authoritative = {
      frozen: true,
      reason: `safety core unreachable: ${(err as Error).message}`,
    };
  }

  const scopeEvents: PortfolioLogEntry[] = [];
  const ports = buildPorts(body.freezes, authoritative, scopeEvents);

  let plan;
  try {
    plan = await generateAllocationPlan(body, ports, nowIso());
  } catch (err) {
    res.status(500).json({ error: "plan generation failed", detail: (err as Error).message });
    return;
  }

  // Emit one PM_PLAN_GENERATED summary plus per-scope vault entries.
  const severity =
    plan.riskGovernorOverridden || plan.recommendedAggressionLevel === "FROZEN"
      ? "DANGER"
      : plan.blockers.length > 0
        ? "WARN"
        : "INFO";

  await logEvent("PM_PLAN_GENERATED", severity, {
    planId: plan.planId,
    recommendedAggressionLevel: plan.recommendedAggressionLevel,
    riskGovernorOverridden: plan.riskGovernorOverridden,
    deployableR: plan.riskBudget.deployableR,
    reserveR: plan.riskBudget.reserveR,
    exposureRiskScore: plan.exposureRiskScore,
    correlatedExposureScore: plan.correlatedExposureScore,
    strategyCount: plan.strategies.length,
    restrictionCount: plan.recommendedRestrictions.length,
  });

  // Per-scope events derived from the orchestrator's emitted log entries.
  for (const ev of scopeEvents) {
    const eventType = scopeToEventType(ev.scope);
    const evSev: "INFO" | "WARN" | "DANGER" =
      ev.scope === "OVERRIDE" ? "DANGER" : "INFO";
    await logEvent(eventType, evSev, {
      planId: plan.planId, scope: ev.scope, refId: ev.refId,
      reasons: ev.reasons,
    });
  }

  res.json({ ...ADVISORY, plan });
});

function scopeToEventType(scope: PortfolioLogEntry["scope"]): string {
  switch (scope) {
    case "PLAN":     return "PM_PLAN_LOGGED";
    case "BUDGET":   return "PM_RISK_BUDGET_DERIVED";
    case "STRATEGY": return "PM_STRATEGY_ALLOCATION_DERIVED";
    case "SYMBOL":   return "PM_SYMBOL_PRIORITIZED";
    case "SESSION":  return "PM_SESSION_PRIORITIZED";
    case "AGENT":    return "PM_AGENT_AUTHORITY_ALLOCATED";
    case "EXPOSURE": return "PM_EXPOSURE_BALANCED";
    case "ROTATION": return "PM_ROTATION_DECIDED";
    case "OVERRIDE": return "PM_OVERRIDE_APPLIED";
    case "CLIMATE":     return "PM_CLIMATE_ASSESSED";
    case "EFFICIENCY":  return "PM_EFFICIENCY_COMPUTED";
    case "FATIGUE":     return "PM_FATIGUE_ASSESSED";
    case "COMPETITION": return "PM_COMPETITION_RANKED";
    case "HEALTH":      return "PM_HEALTH_SCORED";
    case "ECOSYSTEM":   return "PM_ECOSYSTEM_COMPUTED";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-engine endpoints (advisory; vault-logged).
// ─────────────────────────────────────────────────────────────────────────
const ReserveBodySchema = z.object({
  rules: AccountRiskRulesSchema,
  regimeUncertainty01: z.number().min(0).max(1),
  accountDrawdownFraction01: z.number().min(0).max(1),
  frozenStrategiesCount: z.number().int().nonnegative(),
  decayedStrategiesCount: z.number().int().nonnegative(),
  totalStrategiesCount: z.number().int().nonnegative(),
  activeRegime: MarketRegimeSchema,
}).strict();

router.post("/portfolio/reserve", async (req, res) => {
  const body = parseOr400(ReserveBodySchema, req.body, res);
  if (!body) return;
  const out = computeReserveFraction(body);
  await logEvent("PM_RESERVE_DERIVED", "INFO", { reserveFraction01: out.reserveFraction01 });
  res.json({ ...ADVISORY, ...out });
});

const RiskBudgetBodySchema = z.object({
  rules: AccountRiskRulesSchema,
  reserveFraction01: z.number().min(0).max(1),
}).strict();

router.post("/portfolio/risk-budget", async (req, res) => {
  const body = parseOr400(RiskBudgetBodySchema, req.body, res);
  if (!body) return;
  const out = computeRiskBudget(body);
  await logEvent("PM_RISK_BUDGET_DERIVED", out.blockers.length > 0 ? "WARN" : "INFO",
    { totalRiskBudgetR: out.totalRiskBudgetR, deployableR: out.deployableR, reserveR: out.reserveR });
  res.json({ ...ADVISORY, ...out });
});

const StrategyAllocBodySchema = z.object({
  strategies: z.array(StrategyMetricsSchema).min(1),
  rules: AccountRiskRulesSchema,
  reserveFraction01: z.number().min(0).max(1),
  activeRegime: MarketRegimeSchema,
  activeSession: TradingSessionSchema,
}).strict();

router.post("/portfolio/strategy-allocation", async (req, res) => {
  const body = parseOr400(StrategyAllocBodySchema, req.body, res);
  if (!body) return;
  const riskBudget = computeRiskBudget({ rules: body.rules, reserveFraction01: body.reserveFraction01 });
  const out = allocateStrategies({
    strategies: body.strategies, riskBudget,
    activeRegime: body.activeRegime, activeSession: body.activeSession,
  });
  await logEvent("PM_STRATEGY_ALLOCATION_DERIVED", "INFO", {
    totalAllocatedR: out.totalAllocatedR,
    perStrategy: out.allocations.map((a) => ({ id: a.strategyId, riskR: a.riskR, weight01: a.weight01 })),
  });
  res.json({ ...ADVISORY, riskBudget, ...out });
});

const ExposureBodySchema = z.object({
  allocations: z.array(StrategyAllocationSchema),
  metrics: z.array(StrategyMetricsSchema),
  symbols: z.array(SymbolContextSchema),
  rules: AccountRiskRulesSchema,
  reserveFraction01: z.number().min(0).max(1),
  highCorrelationThreshold: z.number().min(0).max(1).optional(),
}).strict();

router.post("/portfolio/exposure-balance", async (req, res) => {
  const body = parseOr400(ExposureBodySchema, req.body, res);
  if (!body) return;
  const riskBudget = computeRiskBudget({ rules: body.rules, reserveFraction01: body.reserveFraction01 });
  const out = balanceExposure({
    allocations: body.allocations as StrategyAllocation[],
    metrics: body.metrics, symbols: body.symbols, riskBudget,
    highCorrelationThreshold: body.highCorrelationThreshold,
  });
  await logEvent("PM_EXPOSURE_BALANCED", out.balance.blockers.length > 0 ? "WARN" : "INFO", {
    perSymbolRiskR: out.balance.perSymbolRiskR,
    totalCorrelatedRiskR: out.balance.totalCorrelatedRiskR,
  });
  res.json({ ...ADVISORY, ...out });
});

const ConvictionBodySchema = z.object({
  conviction: z.array(ConvictionInputSchema).min(1),
}).strict();

router.post("/portfolio/conviction", async (req, res) => {
  const body = parseOr400(ConvictionBodySchema, req.body, res);
  if (!body) return;
  const out = convictionWeightedAllocation(body.conviction);
  await logEvent("PM_CONVICTION_ALLOCATED", "INFO", {
    multipliers: out.multipliers.map((m) => ({ id: m.strategyId, mult: m.multiplier })),
  });
  res.json({ ...ADVISORY, multipliers: out.multipliers, reasons: out.reasons });
});

const SurvivalBodySchema = z.object({
  survival: z.array(SurvivalInputSchema).min(1),
  dangerLevel01: z.number().min(0).max(1),
}).strict();

router.post("/portfolio/survival", async (req, res) => {
  const body = parseOr400(SurvivalBodySchema, req.body, res);
  if (!body) return;
  const out = survivalWeightedAllocation({
    strategies: body.survival, dangerLevel01: body.dangerLevel01,
  });
  await logEvent("PM_SURVIVAL_ALLOCATED", "INFO", {
    dangerLevel01: body.dangerLevel01,
    multipliers: out.multipliers.map((m) => ({ id: m.strategyId, mult: m.multiplier })),
  });
  res.json({ ...ADVISORY, multipliers: out.multipliers, reasons: out.reasons });
});

const RotationBodySchema = z.object({
  current: z.array(StrategyAllocationSchema).min(1),
  recentScoresByStrategyId: z.record(z.string(), z.number().min(0).max(1)),
  maxMovePerCycle: z.number().min(0).max(1).optional(),
  minimumDecayToShed: z.number().min(0).max(1).optional(),
}).strict();

router.post("/portfolio/rotation", async (req, res) => {
  const body = parseOr400(RotationBodySchema, req.body, res);
  if (!body) return;
  const out = rotateCapital({
    current: body.current as StrategyAllocation[],
    recentScoresByStrategyId: new Map(Object.entries(body.recentScoresByStrategyId)),
    maxMovePerCycle: body.maxMovePerCycle,
    minimumDecayToShed: body.minimumDecayToShed,
  });
  await logEvent("PM_ROTATION_DECIDED", "INFO", {
    deltas: out.deltas.map((d) => ({ id: d.strategyId, delta: d.deltaWeight01 })),
  });
  res.json({ ...ADVISORY, ...out });
});

const SymbolPriorityBodySchema = z.object({
  symbols: z.array(SymbolContextSchema).min(1),
  rules: AccountRiskRulesSchema,
  reserveFraction01: z.number().min(0).max(1),
}).strict();

router.post("/portfolio/symbol-priority", async (req, res) => {
  const body = parseOr400(SymbolPriorityBodySchema, req.body, res);
  if (!body) return;
  const riskBudget = computeRiskBudget({ rules: body.rules, reserveFraction01: body.reserveFraction01 });
  const out = computeSymbolPriorities(body.symbols, riskBudget);
  await logEvent("PM_SYMBOL_PRIORITIZED", "INFO", {
    symbols: out.map((s) => ({ id: s.symbolId, p: s.priority01 })),
  });
  res.json({ ...ADVISORY, priorities: out, riskBudget });
});

const SessionPriorityBodySchema = z.object({
  sessions: z.array(SessionContextSchema).min(1),
  rules: AccountRiskRulesSchema,
  reserveFraction01: z.number().min(0).max(1),
}).strict();

router.post("/portfolio/session-priority", async (req, res) => {
  const body = parseOr400(SessionPriorityBodySchema, req.body, res);
  if (!body) return;
  const riskBudget = computeRiskBudget({ rules: body.rules, reserveFraction01: body.reserveFraction01 });
  const out = computeSessionPriorities(body.sessions, riskBudget);
  await logEvent("PM_SESSION_PRIORITIZED", "INFO", {
    sessions: out.map((s) => ({ session: s.session, p: s.priority01 })),
  });
  res.json({ ...ADVISORY, priorities: out, riskBudget });
});

const AgentAuthorityBodySchema = z.object({
  agents: z.array(AgentContextSchema).min(1),
}).strict();

router.post("/portfolio/agent-authority", async (req, res) => {
  const body = parseOr400(AgentAuthorityBodySchema, req.body, res);
  if (!body) return;
  const out = allocateAgentAuthority(body.agents);
  await logEvent("PM_AGENT_AUTHORITY_ALLOCATED", "INFO", {
    authority: out.map((a) => ({ id: a.agentId, w: a.voteWeight01 })),
  });
  res.json({ ...ADVISORY, authority: out });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 9 — Dynamic Capital Ecosystem (advisory).
// ─────────────────────────────────────────────────────────────────────────
router.post("/portfolio/ecosystem", async (req, res) => {
  const body = parseOr400(EcosystemBodySchema, req.body, res);
  if (!body) return;
  const out = computeEcosystem({
    input: body.ecosystem,
    strategies: body.strategies,
    baseReserveFraction01: body.baseReserveFraction01,
    baseAggression: "BALANCED",
    regimeUncertainty01: body.regimeUncertainty01,
    accountDrawdownFraction01: body.accountDrawdownFraction01,
    totalDeployedR: body.totalDeployedR,
    deployableR: body.deployableR,
    perSymbolRiskR: body.perSymbolRiskR,
    perStrategyRiskR: body.perStrategyRiskR,
    perSessionRiskR: body.perSessionRiskR,
    agents: body.agents,
  });
  await logEvent("PM_ECOSYSTEM_COMPUTED", "INFO", {
    shifts: out.report.shifts.length,
    expandedReserveFraction01: out.expandedReserveFraction01,
  });
  res.json({ ...ADVISORY, ecosystem: out.report });
});

export default router;
