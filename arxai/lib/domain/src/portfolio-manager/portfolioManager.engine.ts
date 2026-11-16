import {
  type AccountRiskRules, type StrategyMetrics, type SymbolContext,
  type SessionContext, type AgentContext, type MarketRegime, type TradingSession,
  type AllocationPlan, type StrategyAllocation, type PortfolioLogEntry,
  type StrategyRestriction, type AggressionLevel, type StrategyMultiplierEntry,
  type ReserveAllocation, type RiskBudget,
  type EcosystemInput, type EcosystemReport,
  clamp01, clampNonNegative,
} from "./portfolio.types";
import { computeReserveFraction } from "./reserveCapital.engine";
import { computeRiskBudget } from "./riskBudget.engine";
import { allocateStrategies } from "./strategyAllocation.engine";
import { balanceExposure } from "./exposureBalancer.engine";
import { computeSymbolPriorities } from "./symbolPriority.engine";
import { computeSessionPriorities } from "./sessionPriority.engine";
import { allocateAgentAuthority } from "./agentAuthorityAllocation.engine";
import {
  convictionWeightedAllocation, type ConvictionInput,
} from "./convictionWeightedAllocation.engine";
import {
  survivalWeightedAllocation, type SurvivalInput,
} from "./survivalWeightedAllocation.engine";
import { expandReserve } from "./climate";
import { computeEcosystem } from "./ecosystem";

// Empty ecosystem report used in the FROZEN short-circuit so the schema
// invariant (ecosystem always populated) holds even when we skip Phase 9.
function emptyEcosystemReport(): EcosystemReport {
  return {
    capitalClimate: null, aggressionClimate: null,
    preservationClimate: null, reserveExpansion: null,
    capitalEfficiency: null, riskAdjustedEfficiency: null,
    executionAdjustedAllocation: null,
    survivabilityAdjustedAllocation: null,
    capitalFatigue: null, overdeployment: null,
    concentrationRisk: null,
    strategyCompetition: null, allocationTrust: null,
    authorityCompetition: null,
    fragilityScore: null, diversification: null,
    liquidityAwareDeployment: null, portfolioHealth: null,
    ecosystemMultipliersById: {}, liquidityMultipliersBySymbol: {},
    shifts: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Manager — orchestrator. Composes all sub-engines into one
// AllocationPlan with the Phase 9 spec outputs:
//
//   • portfolioRiskBudget, strategyAllocationMap, reserveAllocation
//   • convictionAllocation, survivalAllocation
//   • exposureRiskScore, correlatedExposureScore
//   • recommendedRestrictions, recommendedAggressionLevel
//
// Hard rules:
//
//   • Risk Governor (port) has FINAL VETO. If frozen, all strategy and
//     agent allocations are zeroed and riskGovernorOverridden=true.
//   • The plan never exceeds account-wide risk caps.
//   • Edge-decay penalties + conviction multipliers + survival multipliers
//     compose AFTER strategy allocation, then totals are re-clamped to
//     deployable.
//   • Approved strategies are NOT equally allocated — softmax over
//     composite scores.
//   • Every plan and decision is logged to Black Box Vault.
// ═══════════════════════════════════════════════════════════════════════════

export interface PortfolioPorts {
  riskGovernor: {
    isFrozen(scope: "ACCOUNT" | "STRATEGY" | "AGENT", refId: string):
      Promise<boolean> | boolean;
    freezeReason?(scope: "ACCOUNT" | "STRATEGY" | "AGENT", refId: string):
      Promise<string | undefined> | string | undefined;
  };
  emitVaultLog(entry: PortfolioLogEntry): Promise<void> | void;
  newEntryId(): string;
  newPlanId(): string;
}

export interface PortfolioInput {
  rules: AccountRiskRules;
  strategies: ReadonlyArray<StrategyMetrics>;
  symbols: ReadonlyArray<SymbolContext>;
  sessions: ReadonlyArray<SessionContext>;
  agents: ReadonlyArray<AgentContext>;
  activeRegime: MarketRegime;
  activeSession: TradingSession;
  regimeUncertainty01: number;
  accountDrawdownFraction01: number;
  /** Per-strategy conviction calibration; missing strategies default to multiplier 1. */
  conviction?: ReadonlyArray<ConvictionInput>;
  /** Per-strategy survival inputs; missing strategies default to multiplier 1. */
  survival?: ReadonlyArray<SurvivalInput>;
  /** Phase 9 dynamic ecosystem inputs. Optional — engines run with safe defaults. */
  ecosystem?: EcosystemInput;
}

export async function generateAllocationPlan(
  input: PortfolioInput,
  ports: PortfolioPorts,
  generatedAtIso: string,
): Promise<AllocationPlan> {
  const reasons: string[] = [];
  const blockers: string[] = [];

  // 1) Reserve fraction.
  const frozenStrategies = await Promise.all(
    input.strategies.map(async (s) => ({
      id: s.strategyId, frozen: await ports.riskGovernor.isFrozen("STRATEGY", s.strategyId),
    })));
  const frozenCount = frozenStrategies.filter((x) => x.frozen).length;
  const decayedCount = input.strategies.filter((s) => s.edgeDecaySlope < 0).length;
  const reserve = computeReserveFraction({
    rules: input.rules,
    regimeUncertainty01: input.regimeUncertainty01,
    accountDrawdownFraction01: input.accountDrawdownFraction01,
    frozenStrategiesCount: frozenCount,
    decayedStrategiesCount: decayedCount,
    totalStrategiesCount: input.strategies.length,
    activeRegime: input.activeRegime,
  });
  reasons.push(...reserve.reasons.map((r) => `[reserve] ${r}`));

  // 1.5) Reserve EXPANSION — the ecosystem can demand a larger reserve in
  // hostile climate / preservation / drawdown regimes. Computed inline so
  // the budget below uses the expanded fraction.
  const climateForExpansion = (() => {
    // Inline lightweight climate score for expansion only; full climate
    // (with all signals) is recomputed in computeEcosystem below.
    const e = input.ecosystem ?? {};
    const benign =
        0.20 * (1 - clamp01(input.regimeUncertainty01))
      + 0.20 * (1 - clamp01(input.accountDrawdownFraction01))
      + 0.15 * (1 - clamp01(e.agentDisagreement01 ?? 0))
      + 0.20 * clamp01(e.executionQualityAvg01 ?? 1)
      + 0.15 * clamp01(e.confidenceHealth01 ?? 1)
      + 0.10 * (1 - clamp01(e.cognitiveRisk01 ?? 0));
    return clamp01(benign);
  })();
  const reserveExp = expandReserve({
    baseReserveFraction01: reserve.reserveFraction01,
    climateScore01: climateForExpansion,
    preservationScore01: clamp01(
      0.45 * (1 - climateForExpansion)
        + 0.30 * input.accountDrawdownFraction01
        + 0.25 * (input.ecosystem?.ruinHazard01 ?? 0),
    ),
    accountDrawdownFraction01: input.accountDrawdownFraction01,
  });
  const effectiveReserveFraction = reserveExp.expandedReserveFraction01;
  if (reserveExp.addedFraction01 > 0.001) {
    reasons.push(...reserveExp.reasons.map((r) => `[reserve-expansion] ${r}`));
  }

  // 2) Risk budget — now using the expanded reserve fraction.
  const riskBudget = computeRiskBudget({
    rules: input.rules, reserveFraction01: effectiveReserveFraction,
  });
  reasons.push(...riskBudget.reasons.map((r) => `[budget] ${r}`));
  blockers.push(...riskBudget.blockers);

  const reserveAllocation: ReserveAllocation = {
    reserveR: riskBudget.reserveR,
    reserveFraction01: riskBudget.reserveFraction01,
    reasons: reserve.reasons,
  };

  // 3) Account-level Risk Governor freeze — short-circuit to zero plan.
  const accountFrozen = await ports.riskGovernor.isFrozen("ACCOUNT", "*");
  if (accountFrozen) {
    const reason = (await ports.riskGovernor.freezeReason?.("ACCOUNT", "*")) ?? "(unspecified)";
    reasons.push(`Risk Governor froze ACCOUNT: ${reason} — zeroing all allocations`);
    const zeroAllocs = input.strategies.map((s) =>
      zeroStrategyAllocation(s.strategyId, `account frozen: ${reason}`));
    const zeroPlan: AllocationPlan = await emitAndReturn({
      planId: ports.newPlanId(), generatedAtIso,
      portfolioRiskBudget: riskBudget, riskBudget,
      reserveAllocation,
      strategyAllocationMap: Object.fromEntries(zeroAllocs.map((a) => [a.strategyId, a])),
      strategies: zeroAllocs,
      symbols: [], sessions: [],
      agents: input.agents.map((a) => ({ agentId: a.agentId, voteWeight01: 0, reasons: [`account frozen`], blockers: [reason] })),
      exposure: { perSymbolRiskR: {}, totalCorrelatedRiskR: 0, reasons: [`account frozen`], blockers: [reason] },
      convictionAllocation: [],
      survivalAllocation: [],
      exposureRiskScore: 0,
      correlatedExposureScore: 0,
      recommendedRestrictions: input.strategies.map((s) => ({
        strategyId: s.strategyId, restriction: "FREEZE",
        reasons: [`account frozen: ${reason}`],
      })),
      recommendedAggressionLevel: "FROZEN",
      riskGovernorOverridden: true,
      ecosystem: emptyEcosystemReport(),
      reasons, blockers,
    }, ports, generatedAtIso, [{ scope: "ACCOUNT", refId: "*", reason }]);
    return zeroPlan;
  }

  // 4) Strategy allocation. Per-strategy freeze zeros that strategy.
  const allocOut = allocateStrategies({
    strategies: input.strategies,
    riskBudget,
    activeRegime: input.activeRegime,
    activeSession: input.activeSession,
  });
  reasons.push(...allocOut.reasons.map((r) => `[strategy] ${r}`));

  let allocations: StrategyAllocation[] = allocOut.allocations.map((a) => ({ ...a }));
  const frozenMap = new Map(frozenStrategies.map((x) => [x.id, x.frozen]));
  const overrideEntries: Array<{ scope: "STRATEGY" | "AGENT"; refId: string; reason: string }> = [];
  for (const a of allocations) {
    if (frozenMap.get(a.strategyId)) {
      const reason = (await ports.riskGovernor.freezeReason?.("STRATEGY", a.strategyId)) ?? "(unspecified)";
      a.reasons.push(`Risk Governor froze strategy: ${reason} — riskR forced to 0`);
      a.blockers.push(`frozen: ${reason}`);
      a.riskR = 0; a.weight01 = 0;
      overrideEntries.push({ scope: "STRATEGY", refId: a.strategyId, reason });
    }
  }

  // 5) Exposure balance.
  const balanced = balanceExposure({
    allocations, metrics: input.strategies, symbols: input.symbols, riskBudget,
  });
  allocations = balanced.adjustedAllocations.map((a) => ({ ...a }));
  reasons.push(...balanced.reasons.map((r) => `[exposure] ${r}`));

  // 6) Conviction-weighted allocation overlay.
  const convInputs = input.conviction ?? [];
  const convOut = convictionWeightedAllocation(convInputs);
  reasons.push(...convOut.reasons.map((r) => `[conviction] ${r}`));

  // 7) Survival-weighted allocation overlay.
  const survInputs = input.survival ?? [];
  const dangerLevel01 = clamp01(Math.max(
    input.regimeUncertainty01, input.accountDrawdownFraction01,
  ));
  const survOut = survivalWeightedAllocation({
    strategies: survInputs, dangerLevel01,
  });
  reasons.push(...survOut.reasons.map((r) => `[survival] ${r}`));

  // 8) Apply conviction × survival multipliers to non-frozen allocations.
  for (const a of allocations) {
    if (frozenMap.get(a.strategyId)) continue;
    if (a.riskR === 0) continue;
    const cm = convOut.multipliersById.get(a.strategyId) ?? 1;
    const sm = survOut.multipliersById.get(a.strategyId) ?? 1;
    const combined = cm * sm;
    if (combined !== 1) {
      const old = a.riskR;
      a.riskR = clampNonNegative(old * combined);
      a.weight01 = clamp01(a.weight01 * combined);
      a.reasons.push(`conviction×survival ${cm.toFixed(3)} × ${sm.toFixed(3)} = ${combined.toFixed(3)}: riskR ${old.toFixed(2)} → ${a.riskR.toFixed(2)}`);
    }
  }

  // 9a) Re-balance exposure AFTER conviction×survival overlay so the
  // overlay cannot re-inflate per-symbol concentration above its cap.
  let rebalanced = balanceExposure({
    allocations, metrics: input.strategies, symbols: input.symbols, riskBudget,
  });
  allocations = rebalanced.adjustedAllocations.map((a) => ({ ...a }));
  reasons.push(...rebalanced.reasons.map((r) => `[exposure-post-overlay] ${r}`));

  // 9a.5) Phase 9 — DYNAMIC CAPITAL ECOSYSTEM overlay. Computes climate,
  // efficiency, fatigue, competition and health using the post-overlay
  // exposure, then layers ecosystem multipliers on each strategy and
  // liquidity-aware deployment cuts on each symbol.
  const perStrategyRiskR: Record<string, number> = {};
  for (const a of allocations) perStrategyRiskR[a.strategyId] = a.riskR;
  const perSessionRiskR: Record<string, number> = {};
  for (const a of allocations) {
    const m = input.strategies.find((s) => s.strategyId === a.strategyId);
    const sessions = m?.designedSessions ?? [input.activeSession];
    // Distribute the strategy's risk equally across its designed sessions.
    const share = a.riskR / Math.max(sessions.length, 1);
    for (const sess of sessions) {
      perSessionRiskR[sess] = (perSessionRiskR[sess] ?? 0) + share;
    }
  }
  const totalDeployedR = allocations.reduce((s, a) => s + a.riskR, 0);

  // Compute the BASE aggression up-front so the climate engine can downgrade
  // it monotonically (passing a hard-coded BALANCED would clamp the
  // ecosystem's view of the ceiling and mask AGGRESSIVE in calm regimes).
  const baseAggression = computeAggressionLevel({
    reserveFraction01: riskBudget.reserveFraction01,
    accountDrawdownFraction01: input.accountDrawdownFraction01,
    regimeUncertainty01: input.regimeUncertainty01,
    activeRegime: input.activeRegime,
    frozenCount, totalCount: input.strategies.length,
  });

  const ecoComp = computeEcosystem({
    input: input.ecosystem,
    strategies: input.strategies,
    baseReserveFraction01: reserve.reserveFraction01,
    baseAggression, // climate engine applies its ceiling on top
    regimeUncertainty01: input.regimeUncertainty01,
    accountDrawdownFraction01: input.accountDrawdownFraction01,
    totalDeployedR,
    deployableR: Math.max(riskBudget.deployableR, 1e-6),
    perSymbolRiskR: rebalanced.balance.perSymbolRiskR,
    perStrategyRiskR,
    perSessionRiskR,
    agents: input.agents,
  });

  // Apply ecosystem per-strategy multiplier.
  for (const a of allocations) {
    if (frozenMap.get(a.strategyId)) continue;
    if (a.riskR === 0) continue;
    const m = ecoComp.report.ecosystemMultipliersById[a.strategyId] ?? 1;
    if (Math.abs(m - 1) > 1e-6) {
      const old = a.riskR;
      a.riskR = clampNonNegative(old * m);
      a.weight01 = clamp01(a.weight01 * m);
      a.reasons.push(`ecosystem multiplier ${m.toFixed(3)}: riskR ${old.toFixed(2)} → ${a.riskR.toFixed(2)}`);
    }
  }
  // Apply liquidity-aware per-symbol cut: scale by min liquidity multiplier
  // across the strategy's designedSymbols (worst symbol drives the cut).
  if (Object.keys(ecoComp.report.liquidityMultipliersBySymbol).length > 0) {
    for (const a of allocations) {
      if (frozenMap.get(a.strategyId)) continue;
      if (a.riskR === 0) continue;
      const m = input.strategies.find((s) => s.strategyId === a.strategyId);
      if (!m) continue;
      let minLiq = 1;
      for (const sym of m.designedSymbols) {
        const lm = ecoComp.report.liquidityMultipliersBySymbol[sym];
        if (lm !== undefined && lm < minLiq) minLiq = lm;
      }
      if (minLiq < 1) {
        const old = a.riskR;
        a.riskR = clampNonNegative(old * minLiq);
        a.weight01 = clamp01(a.weight01 * minLiq);
        a.reasons.push(`liquidity-aware deployment × ${minLiq.toFixed(3)}: ` +
                       `riskR ${old.toFixed(2)} → ${a.riskR.toFixed(2)}`);
      }
    }
  }

  // 9a.6) Re-balance again after ecosystem + liquidity overlay.
  rebalanced = balanceExposure({
    allocations, metrics: input.strategies, symbols: input.symbols, riskBudget,
  });
  allocations = rebalanced.adjustedAllocations.map((a) => ({ ...a }));
  reasons.push(...rebalanced.reasons.map((r) => `[exposure-post-ecosystem] ${r}`));
  const finalExposure = rebalanced.balance;

  // 9b.0) Hard per-strategy cap re-clamp. Overlays (conviction × survival ×
  // ecosystem multiplier) can multiply riskR upward — re-clamp each strategy
  // back to perStrategyCapR so this binding cap cannot be bypassed.
  if (riskBudget.perStrategyCapR > 0) {
    for (const a of allocations) {
      if (a.riskR > riskBudget.perStrategyCapR + 1e-6) {
        const old = a.riskR;
        const scale = riskBudget.perStrategyCapR / old;
        a.riskR = riskBudget.perStrategyCapR;
        a.weight01 = clamp01(a.weight01 * scale);
        a.reasons.push(`per-strategy cap re-clamp ${old.toFixed(2)} → ${a.riskR.toFixed(2)}`);
      }
    }
  }

  // 9b.1) Per-session cap enforcement. Sum strategy risk by designed
  // session(s) (split equally across designedSessions) and scale every
  // contributing strategy down if any session exceeds perSessionCapR.
  if (riskBudget.perSessionCapR > 0) {
    for (let pass = 0; pass < 3; pass++) {
      const sessSum: Record<string, number> = {};
      const sessContribs: Record<string, Array<{ a: StrategyAllocation; share: number }>> = {};
      for (const a of allocations) {
        const m = input.strategies.find((s) => s.strategyId === a.strategyId);
        const sessions = m?.designedSessions ?? [input.activeSession];
        const share = a.riskR / Math.max(sessions.length, 1);
        for (const s of sessions) {
          sessSum[s] = (sessSum[s] ?? 0) + share;
          (sessContribs[s] ??= []).push({ a, share });
        }
      }
      let anyOver = false;
      for (const [s, sum] of Object.entries(sessSum)) {
        if (sum > riskBudget.perSessionCapR + 1e-6) {
          anyOver = true;
          const scale = riskBudget.perSessionCapR / sum;
          const seen = new Set<string>();
          for (const { a } of sessContribs[s]!) {
            if (seen.has(a.strategyId)) continue;
            seen.add(a.strategyId);
            const old = a.riskR;
            a.riskR = clampNonNegative(old * scale);
            a.weight01 = clamp01(a.weight01 * scale);
            a.reasons.push(`per-session(${s}) cap re-clamp × ${scale.toFixed(3)}: ${old.toFixed(2)} → ${a.riskR.toFixed(2)}`);
          }
          reasons.push(`per-session cap on ${s} forced × ${scale.toFixed(3)}`);
        }
      }
      if (!anyOver) break;
    }
  }

  // 9b) Final account-wide guardrail — total strategy risk must not exceed
  // deployable. After overlays + re-balance, re-scale if needed.
  const totalRiskR = allocations.reduce((s, a) => s + a.riskR, 0);
  if (totalRiskR > riskBudget.deployableR + 1e-6) {
    blockers.push(`total strategy risk ${totalRiskR.toFixed(2)} exceeds deployable ${riskBudget.deployableR.toFixed(2)}`);
    const scale = riskBudget.deployableR / totalRiskR;
    for (const a of allocations) {
      a.riskR = a.riskR * scale; a.weight01 = a.weight01 * scale;
      a.reasons.push(`final guardrail rebalance × ${scale.toFixed(3)}`);
    }
    reasons.push(`final guardrail re-scaled all strategies by ${scale.toFixed(3)}`);
  }

  // 10) Symbol & session priorities (advisory caps for downstream routers).
  const symbolPriorities = computeSymbolPriorities(input.symbols, riskBudget);
  const sessionPriorities = computeSessionPriorities(input.sessions, riskBudget);

  // 11) Agent authority — apply Risk Governor freeze to individual agents.
  const agentsWithFreeze = await Promise.all(input.agents.map(async (a) => {
    const govFrozen = await ports.riskGovernor.isFrozen("AGENT", a.agentId);
    if (govFrozen && !a.isFrozen) {
      const reason = (await ports.riskGovernor.freezeReason?.("AGENT", a.agentId)) ?? "(unspecified)";
      overrideEntries.push({ scope: "AGENT", refId: a.agentId, reason });
    }
    return { ...a, isFrozen: a.isFrozen || govFrozen };
  }));
  const agentAuth = allocateAgentAuthority(agentsWithFreeze);

  const partialOverride = overrideEntries.length > 0;
  if (partialOverride) {
    reasons.push(`Risk Governor PARTIAL override: ${overrideEntries.length} scoped freeze(s)`);
  }

  // 12) Compute derived spec outputs from the POST-overlay exposure (the
  // pre-overlay exposure object would have been stale).
  const exposureRiskScore = computeExposureRiskScore(finalExposure.perSymbolRiskR, riskBudget);
  const correlatedExposureScore = clamp01(
    riskBudget.deployableR > 0
      ? finalExposure.totalCorrelatedRiskR / riskBudget.deployableR
      : 0,
  );

  const convictionAllocation: StrategyMultiplierEntry[] = convOut.multipliers.map((m) => ({
    strategyId: m.strategyId, multiplier: m.multiplier, reasons: m.reasons,
  }));
  const survivalAllocation: StrategyMultiplierEntry[] = survOut.multipliers.map((m) => ({
    strategyId: m.strategyId, multiplier: m.multiplier, reasons: m.reasons,
  }));

  const recommendedRestrictions = computeRecommendedRestrictions({
    allocations, frozenMap,
    convMult: convOut.multipliersById,
    metrics: input.strategies,
  });

  // The aggression climate engine has already done the monotonic min(base,
  // climateCeiling) above; just take its result.
  const recommendedAggressionLevel: AggressionLevel = ecoComp.aggression.recommendedAggression;
  if (ecoComp.aggression.downgraded) {
    reasons.push(`[aggression-climate] base ${baseAggression} downgraded to ${recommendedAggressionLevel} ` +
      `(climate score ${(ecoComp.climate.climateScore01).toFixed(3)} → ${ecoComp.climate.tier})`);
  }

  return await emitAndReturn({
    planId: ports.newPlanId(), generatedAtIso,
    portfolioRiskBudget: riskBudget, riskBudget,
    reserveAllocation,
    strategyAllocationMap: Object.fromEntries(allocations.map((a) => [a.strategyId, a])),
    strategies: allocations,
    symbols: symbolPriorities.map((p) => ({ ...p })),
    sessions: sessionPriorities.map((p) => ({ ...p })),
    agents: agentAuth.map((a) => ({ ...a })),
    exposure: finalExposure,
    convictionAllocation,
    survivalAllocation,
    exposureRiskScore,
    correlatedExposureScore,
    recommendedRestrictions,
    recommendedAggressionLevel,
    riskGovernorOverridden: partialOverride,
    ecosystem: ecoComp.report,
    reasons, blockers,
  }, ports, generatedAtIso, overrideEntries);
}

// ── helpers ────────────────────────────────────────────────────────────────
function zeroStrategyAllocation(strategyId: string, reason: string): StrategyAllocation {
  return {
    strategyId, weight01: 0, riskR: 0, stageCapR: 0,
    edgeDecayPenalty01: 0, reasons: [reason], blockers: [reason],
  };
}

function computeExposureRiskScore(
  perSymbolRiskR: Record<string, number>, budget: RiskBudget,
): number {
  if (budget.perSymbolCapR <= 0) return 0;
  let max = 0;
  for (const v of Object.values(perSymbolRiskR)) if (v > max) max = v;
  return clamp01(max / budget.perSymbolCapR);
}

function computeRecommendedRestrictions(args: {
  allocations: ReadonlyArray<StrategyAllocation>;
  frozenMap: Map<string, boolean>;
  convMult: ReadonlyMap<string, number>;
  metrics: ReadonlyArray<StrategyMetrics>;
}): StrategyRestriction[] {
  const metricsById = new Map(args.metrics.map((m) => [m.strategyId, m]));
  const out: StrategyRestriction[] = [];
  for (const a of args.allocations) {
    const m = metricsById.get(a.strategyId);
    const r: string[] = [];
    let kind: StrategyRestriction["restriction"] | null = null;
    if (args.frozenMap.get(a.strategyId)) {
      kind = "FREEZE"; r.push(`Risk Governor froze strategy`);
    } else if (a.edgeDecayPenalty01 >= 1) {
      kind = "FREEZE"; r.push(`edge fully decayed`);
    } else if (m && (m.tradeStage === "RESEARCH" || m.tradeStage === "PAPER_TRADING")) {
      kind = "OBSERVE_ONLY"; r.push(`stage ${m.tradeStage} — observe only`);
    } else if (a.weight01 === 0 && a.blockers.length === 0) {
      // Eligible-but-zero typically means regime/session gate failed.
      kind = "PAUSE"; r.push(`ineligible for current regime/session`);
    } else if (a.edgeDecayPenalty01 >= 0.5) {
      kind = "REDUCE"; r.push(`edgeDecayPenalty ${a.edgeDecayPenalty01.toFixed(2)} ≥ 0.5`);
    } else {
      const cm = args.convMult.get(a.strategyId);
      if (cm !== undefined && cm < 0.6) {
        kind = "REDUCE"; r.push(`conviction multiplier ${cm.toFixed(2)} < 0.6 — reduce`);
      }
    }
    if (kind) out.push({ strategyId: a.strategyId, restriction: kind, reasons: r });
  }
  return out;
}

function computeAggressionLevel(args: {
  reserveFraction01: number;
  accountDrawdownFraction01: number;
  regimeUncertainty01: number;
  activeRegime: MarketRegime;
  frozenCount: number; totalCount: number;
}): AggressionLevel {
  const dd = clamp01(args.accountDrawdownFraction01);
  const unc = clamp01(args.regimeUncertainty01);
  const reserve = clamp01(args.reserveFraction01);
  const frozenShare = args.totalCount > 0 ? args.frozenCount / args.totalCount : 0;

  if (args.activeRegime === "CRASH") return "OBSERVE_ONLY";
  if (reserve > 0.7 || dd > 0.6 || unc > 0.8) return "OBSERVE_ONLY";
  if (reserve > 0.5 || dd > 0.3 || unc > 0.5 || frozenShare > 0.34) return "CONSERVATIVE";
  if (reserve < 0.25 && dd < 0.15 && unc < 0.3 && frozenShare === 0) return "AGGRESSIVE";
  return "BALANCED";
}

async function emitAndReturn(
  plan: AllocationPlan, ports: PortfolioPorts, atIso: string,
  overrides: ReadonlyArray<{ scope: "ACCOUNT" | "STRATEGY" | "AGENT"; refId: string; reason: string }> = [],
): Promise<AllocationPlan> {
  await safeEmit(ports, {
    entryId: ports.newEntryId(), scope: "PLAN", refId: plan.planId,
    payloadJson: JSON.stringify(plan), recordedAtIso: atIso, reasons: plan.reasons,
  }, plan.blockers);
  await safeEmit(ports, {
    entryId: ports.newEntryId(), scope: "BUDGET", refId: plan.planId,
    payloadJson: JSON.stringify(plan.riskBudget), recordedAtIso: atIso, reasons: plan.riskBudget.reasons,
  }, plan.blockers);
  for (const a of plan.strategies) {
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "STRATEGY", refId: a.strategyId,
      payloadJson: JSON.stringify(a), recordedAtIso: atIso, reasons: a.reasons,
    }, plan.blockers);
  }
  for (const s of plan.symbols) {
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "SYMBOL", refId: s.symbolId,
      payloadJson: JSON.stringify(s), recordedAtIso: atIso, reasons: s.reasons,
    }, plan.blockers);
  }
  for (const s of plan.sessions) {
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "SESSION", refId: s.session,
      payloadJson: JSON.stringify(s), recordedAtIso: atIso, reasons: s.reasons,
    }, plan.blockers);
  }
  for (const ag of plan.agents) {
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "AGENT", refId: ag.agentId,
      payloadJson: JSON.stringify(ag), recordedAtIso: atIso, reasons: ag.reasons,
    }, plan.blockers);
  }
  await safeEmit(ports, {
    entryId: ports.newEntryId(), scope: "EXPOSURE", refId: plan.planId,
    payloadJson: JSON.stringify(plan.exposure), recordedAtIso: atIso, reasons: plan.exposure.reasons,
  }, plan.blockers);
  // Phase 9 ecosystem-channel vault entries — climate, health, ecosystem.
  if (plan.ecosystem.shifts.length > 0 || plan.ecosystem.capitalClimate !== null) {
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "CLIMATE", refId: plan.planId,
      payloadJson: JSON.stringify({
        climate: plan.ecosystem.capitalClimate,
        aggression: plan.ecosystem.aggressionClimate,
        preservation: plan.ecosystem.preservationClimate,
        reserveExpansion: plan.ecosystem.reserveExpansion,
      }),
      recordedAtIso: atIso,
      reasons: plan.ecosystem.shifts,
    }, plan.blockers);
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "HEALTH", refId: plan.planId,
      payloadJson: JSON.stringify({
        portfolioHealth: plan.ecosystem.portfolioHealth,
        fragility: plan.ecosystem.fragilityScore,
        diversification: plan.ecosystem.diversification,
        concentration: plan.ecosystem.concentrationRisk,
      }),
      recordedAtIso: atIso,
      reasons: plan.ecosystem.shifts,
    }, plan.blockers);
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "ECOSYSTEM", refId: plan.planId,
      payloadJson: JSON.stringify(plan.ecosystem),
      recordedAtIso: atIso,
      reasons: plan.ecosystem.shifts,
    }, plan.blockers);
  }
  for (const ov of overrides) {
    await safeEmit(ports, {
      entryId: ports.newEntryId(), scope: "OVERRIDE", refId: `${ov.scope}:${ov.refId}`,
      payloadJson: JSON.stringify({ scope: ov.scope, refId: ov.refId, reason: ov.reason }),
      recordedAtIso: atIso,
      reasons: [`Risk Governor froze ${ov.scope} ${ov.refId}: ${ov.reason}`],
    }, plan.blockers);
  }
  return plan;
}

async function safeEmit(
  ports: PortfolioPorts, entry: PortfolioLogEntry, blockers: string[],
): Promise<void> {
  try { await ports.emitVaultLog(entry); }
  catch (e) { blockers.push(`emitVaultLog failed for ${entry.scope}/${entry.refId}: ${(e as Error).message}`); }
}
