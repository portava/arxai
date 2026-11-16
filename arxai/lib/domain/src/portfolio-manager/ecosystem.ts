import {
  type EcosystemInput, type EcosystemReport,
  type StrategyMetrics, clamp01,
} from "./portfolio.types";
import {
  assessCapitalClimate, applyAggressionClimate,
  assessPreservationClimate, expandReserve,
  type CapitalClimate, type AggressionClimateOutput,
  type PreservationClimate, type ReserveExpansionOutput,
} from "./climate";
import {
  computeCapitalEfficiency, computeRiskAdjustedEfficiency,
  executionAdjustedAllocation, survivabilityAdjustedAllocation,
} from "./efficiency";
import {
  computeCapitalFatigue, detectOverdeployment, computeConcentrationRisk,
} from "./fatigue";
import {
  rankStrategiesByCompetition, computeAllocationTrust, competeAgentAuthority,
} from "./competition";
import {
  computeFragilityScore, computeDiversification,
  liquidityAwareDeployment, computePortfolioHealth,
} from "./health";
import { type AggressionLevel } from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem composer — runs every Phase 9 sub-engine over the input,
// folds the outputs into a single combined per-strategy multiplier and a
// per-symbol liquidity multiplier, and returns an EcosystemReport block.
//
// Pure. Safe defaults are used for any unsupplied ecosystem field.
// ═══════════════════════════════════════════════════════════════════════════

const D = {
  agentDisagreement01: 0,
  executionQualityAvg01: 1,
  confidenceHealth01: 1,
  cognitiveRisk01: 0,
  ruinHazard01: 0,
  decayedStrategyShare01: 0,
  regimeConcentration01: 0,
  sustainedDeploymentFraction01: 0,
  authoritySeats: 3,
  competitionTopK: 3,
} as const;

export interface EcosystemComputeArgs {
  input: EcosystemInput | undefined;
  strategies: ReadonlyArray<StrategyMetrics>;
  baseReserveFraction01: number;
  baseAggression: AggressionLevel;
  regimeUncertainty01: number;
  accountDrawdownFraction01: number;
  totalDeployedR: number;
  deployableR: number;
  perSymbolRiskR: Record<string, number>;
  perStrategyRiskR: Record<string, number>;
  perSessionRiskR: Record<string, number>;
  agents: ReadonlyArray<{ agentId: string }>;
}

export interface EcosystemComputeResult {
  report: EcosystemReport;
  // Convenience extracts for the orchestrator.
  expandedReserveFraction01: number;
  climate: CapitalClimate;
  aggression: AggressionClimateOutput;
  preservation: PreservationClimate;
  reserveExpansion: ReserveExpansionOutput;
}

export function computeEcosystem(args: EcosystemComputeArgs): EcosystemComputeResult {
  const e = args.input ?? {};

  // ── Climate ────────────────────────────────────────────────────────────
  const climate = assessCapitalClimate({
    regimeUncertainty01: args.regimeUncertainty01,
    accountDrawdownFraction01: args.accountDrawdownFraction01,
    agentDisagreement01: e.agentDisagreement01 ?? D.agentDisagreement01,
    executionQualityAvg01: e.executionQualityAvg01 ?? D.executionQualityAvg01,
    confidenceHealth01: e.confidenceHealth01 ?? D.confidenceHealth01,
    cognitiveRisk01: e.cognitiveRisk01 ?? D.cognitiveRisk01,
  });
  const aggression = applyAggressionClimate({
    climateScore01: climate.climateScore01,
    baseAggression: args.baseAggression,
  });
  const preservation = assessPreservationClimate({
    climateScore01: climate.climateScore01,
    accountDrawdownFraction01: args.accountDrawdownFraction01,
    ruinHazard01: e.ruinHazard01 ?? D.ruinHazard01,
  });
  const reserveExpansion = expandReserve({
    baseReserveFraction01: args.baseReserveFraction01,
    climateScore01: climate.climateScore01,
    preservationScore01: preservation.preservationScore01,
    accountDrawdownFraction01: args.accountDrawdownFraction01,
  });

  // ── Efficiency ────────────────────────────────────────────────────────
  const effInputs = e.perStrategyEfficiency ?? args.strategies.map((s) => ({
    strategyId: s.strategyId, expectancyR: 0, riskRDeployed: 0, downsideR: 0,
  }));
  const capEff = computeCapitalEfficiency(effInputs.map((s) => ({
    strategyId: s.strategyId, expectancyR: s.expectancyR, riskRDeployed: s.riskRDeployed,
  })));
  const riskAdjEff = computeRiskAdjustedEfficiency(effInputs.map((s) => ({
    strategyId: s.strategyId, expectancyR: s.expectancyR, downsideR: s.downsideR,
  })));
  const execInputs = e.perStrategyExecution ?? args.strategies.map((s) => ({
    strategyId: s.strategyId, executionQuality01: D.executionQualityAvg01,
  }));
  const execAdj = executionAdjustedAllocation(execInputs);
  const raMap = new Map(riskAdjEff.perStrategy.map((x) => [x.strategyId, x.riskAdjustedEfficiency]));
  const survAdjInputs = args.strategies.map((s) => ({
    strategyId: s.strategyId,
    riskAdjustedEfficiency: raMap.get(s.strategyId) ?? 0,
    survivalScore01: clamp01(1 - args.accountDrawdownFraction01), // best-effort proxy
  }));
  const survAdj = survivabilityAdjustedAllocation(survAdjInputs);

  // ── Fatigue ───────────────────────────────────────────────────────────
  const runtime = e.perStrategyRuntime ?? args.strategies.map((s) => ({
    strategyId: s.strategyId, deploymentDurationDays: 0, recentDrawdown01: 0,
  }));
  const fatigue = computeCapitalFatigue(runtime);
  const overdep = detectOverdeployment({
    totalDeployedR: args.totalDeployedR,
    deployableR: Math.max(args.deployableR, 1e-6),
    sustainedFraction01: e.sustainedDeploymentFraction01 ?? D.sustainedDeploymentFraction01,
  });
  const concentration = computeConcentrationRisk({
    perSymbolRiskR: args.perSymbolRiskR,
    perStrategyRiskR: args.perStrategyRiskR,
    perSessionRiskR: args.perSessionRiskR,
  });

  // ── Competition ───────────────────────────────────────────────────────
  const trustInputs = e.perStrategyTrust ?? args.strategies.map((s) => ({
    strategyId: s.strategyId, trackRecord01: 0.5, calibration01: 0.5, validationScore01: 0.5,
  }));
  const trust = computeAllocationTrust(trustInputs);
  // composite for competition: 70% trust × 30% efficiency squash
  const compInputs = args.strategies.map((s) => {
    const t = trust.multipliersById.get(s.strategyId) ?? 0.5;
    const ra = raMap.get(s.strategyId) ?? 0;
    const eff01 = (Math.tanh(ra) + 1) / 2;
    return {
      strategyId: s.strategyId,
      compositeScore01: clamp01(0.70 * (t / 1.2) + 0.30 * eff01),
    };
  });
  const competition = rankStrategiesByCompetition(compInputs, e.competitionTopK ?? D.competitionTopK);
  const authorityInputs = e.perAgentAuthority ?? args.agents.map((a) => ({
    agentId: a.agentId, calibration01: 0.5, recentAccuracy01: 0.5, trackRecord01: 0.5,
  }));
  const authorityComp = competeAgentAuthority(authorityInputs, e.authoritySeats ?? D.authoritySeats);

  // ── Health ────────────────────────────────────────────────────────────
  const fragility = computeFragilityScore({
    accountDrawdownFraction01: args.accountDrawdownFraction01,
    correlatedExposureScore01: 0, // orchestrator overlays the real one later if needed
    decayedStrategyShare01: e.decayedStrategyShare01 ?? D.decayedStrategyShare01,
    agentDisagreement01: e.agentDisagreement01 ?? D.agentDisagreement01,
  });
  const diversification = computeDiversification({
    perSymbolRiskR: args.perSymbolRiskR,
    perStrategyRiskR: args.perStrategyRiskR,
    perSessionRiskR: args.perSessionRiskR,
  });
  const liqInputs = e.perSymbolLiquidity ?? [];
  const liquidity = liquidityAwareDeployment(liqInputs);
  const capEff01 = clamp01((Math.tanh(capEff.portfolioEfficiency) + 1) / 2);
  const health = computePortfolioHealth({
    climateScore01: climate.climateScore01,
    fragility01: fragility.fragility01,
    diversification01: diversification.diversification01,
    concentrationIndex01: concentration.concentrationIndex01,
    executionQualityAvg01: e.executionQualityAvg01 ?? D.executionQualityAvg01,
    capitalEfficiency01: capEff01,
    regimeConcentration01: e.regimeConcentration01 ?? D.regimeConcentration01,
  });

  // ── Combined per-strategy ecosystem multiplier ────────────────────────
  const ecosystemMultipliersById: Record<string, number> = {};
  const shifts: string[] = [];
  for (const s of args.strategies) {
    const f  = fatigue.multipliersById.get(s.strategyId) ?? 1;
    const ex = execAdj.multipliersById.get(s.strategyId) ?? 1;
    const sa = survAdj.multipliersById.get(s.strategyId) ?? 1;
    const c  = competition.multipliersById.get(s.strategyId) ?? 1;
    const t  = trust.multipliersById.get(s.strategyId) ?? 1;
    const od = overdep.multiplier;
    // Compose multiplicatively then clamp into [0.1, 1.5] so any single
    // engine cannot dominate or zero-out the entire allocation.
    const raw = f * ex * sa * c * t * od * aggression.aggressionMultiplier01;
    const m = Math.max(0.1, Math.min(1.5, raw));
    ecosystemMultipliersById[s.strategyId] = m;
    if (Math.abs(m - 1) > 0.01) {
      shifts.push(`${s.strategyId}: ecosystem multiplier ${m.toFixed(3)} ` +
        `(fatigue ${f.toFixed(2)} × exec ${ex.toFixed(2)} × survAdj ${sa.toFixed(2)} ` +
        `× comp ${c.toFixed(2)} × trust ${t.toFixed(2)} × overdep ${od.toFixed(2)} ` +
        `× aggression ${aggression.aggressionMultiplier01.toFixed(2)})`);
    }
  }

  // ── Per-symbol liquidity multipliers ──────────────────────────────────
  const liquidityMultipliersBySymbol: Record<string, number> = {};
  for (const [sym, m] of liquidity.multipliersById) {
    liquidityMultipliersBySymbol[sym] = m;
    if (m < 0.99) shifts.push(`symbol ${sym}: liquidity multiplier ${m.toFixed(3)}`);
  }

  if (aggression.downgraded) {
    shifts.push(`aggression downgraded: ${args.baseAggression} → ${aggression.recommendedAggression} ` +
      `(climate ${climate.climateScore01.toFixed(2)})`);
  }
  if (reserveExpansion.addedFraction01 > 0.001) {
    shifts.push(`reserve expanded by ${(reserveExpansion.addedFraction01 * 100).toFixed(1)}% ` +
      `(climate ${climate.climateScore01.toFixed(2)}, preservation ${preservation.preservationMode})`);
  }

  const report: EcosystemReport = {
    capitalClimate: climate, aggressionClimate: aggression,
    preservationClimate: preservation, reserveExpansion,
    capitalEfficiency: capEff, riskAdjustedEfficiency: riskAdjEff,
    executionAdjustedAllocation: execAdj,
    survivabilityAdjustedAllocation: survAdj,
    capitalFatigue: fatigue, overdeployment: overdep,
    concentrationRisk: concentration,
    strategyCompetition: competition, allocationTrust: trust,
    authorityCompetition: authorityComp,
    fragilityScore: fragility, diversification,
    liquidityAwareDeployment: liquidity, portfolioHealth: health,
    ecosystemMultipliersById, liquidityMultipliersBySymbol, shifts,
  };

  return {
    report,
    expandedReserveFraction01: reserveExpansion.expandedReserveFraction01,
    climate, aggression, preservation, reserveExpansion,
  };
}
