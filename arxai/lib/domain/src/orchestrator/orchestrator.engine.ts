import { z } from "zod/v4";
import { selectActiveStrategies, type StrategyDescriptor } from "./strategyPriority.engine";
import { computeAdaptiveAgentWeights, type AgentDescriptor } from "./adaptiveWeighting.engine";
import { applyDefenseMode } from "./defenseMode.engine";
import { applyPreservationMode } from "./preservationMode.engine";
import { applyAggressionScaling } from "./aggressionScaling.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator — central decision layer that controls strategy activation,
// per-agent weighting, and the global mode (NORMAL/DEFENSE/PRESERVATION/
// AGGRESSION). Composes with kill-switch + governor + trust-ladder; never
// bypasses risk. Self-contained — caller adapts inputs from market-state,
// regret-engine, edge-map, kill-switch, trust-ladder.
// ═══════════════════════════════════════════════════════════════════════════

export const OrchestrationModeSchema = z.enum(["NORMAL", "DEFENSE", "PRESERVATION", "AGGRESSION"]);
export type OrchestrationMode = z.infer<typeof OrchestrationModeSchema>;

export interface OrchestrationInputs {
  recentLossStreak: number;
  recentWinStreak: number;
  drawdownPct: number;
  killSwitchActive: boolean;
  trustRungIdx: number;                 // 0..5
  recentExpectancyR: number;
  meanCalibrationErrorPp: number;
  marketPhaseConfidence01: number;      // 0..1 — how confident we are about phase
  observedAt: string;
}

export interface OrchestrationDecision {
  mode: OrchestrationMode;
  activeStrategyIds: string[];
  agentWeightMultipliers: Record<string, number>;
  globalSizeMultiplier: number;
  minConfidenceThreshold: number;       // 0..100
  maxConcurrentTrades: number;
  reasons: string[];
}

export const ORCHESTRATION_THRESHOLDS = {
  preservationDrawdownPct: 8,
  defenseLossStreak: 3,
  defenseDrawdownPct: 4,
  defenseCalErrorPp: 20,
  aggressionWinStreak: 5,
  aggressionMinExpectancyR: 0.30,
  aggressionMaxCalErrorPp: 10,
  aggressionMinTrustRungIdx: 4,
} as const;

export function selectMode(i: OrchestrationInputs): { mode: OrchestrationMode; reasons: string[] } {
  const T = ORCHESTRATION_THRESHOLDS;
  const reasons: string[] = [];
  if (i.killSwitchActive || i.drawdownPct >= T.preservationDrawdownPct) {
    reasons.push(i.killSwitchActive ? "kill-switch active" : `drawdown ${i.drawdownPct.toFixed(1)}% ≥ ${T.preservationDrawdownPct}%`);
    return { mode: "PRESERVATION", reasons };
  }
  if (i.recentLossStreak >= T.defenseLossStreak
      || i.drawdownPct >= T.defenseDrawdownPct
      || i.meanCalibrationErrorPp >= T.defenseCalErrorPp) {
    if (i.recentLossStreak >= T.defenseLossStreak) reasons.push(`loss streak ${i.recentLossStreak} ≥ ${T.defenseLossStreak}`);
    if (i.drawdownPct >= T.defenseDrawdownPct) reasons.push(`drawdown ${i.drawdownPct.toFixed(1)}% ≥ ${T.defenseDrawdownPct}%`);
    if (i.meanCalibrationErrorPp >= T.defenseCalErrorPp) reasons.push(`MACE ${i.meanCalibrationErrorPp.toFixed(1)}pp ≥ ${T.defenseCalErrorPp}pp`);
    return { mode: "DEFENSE", reasons };
  }
  if (i.recentWinStreak >= T.aggressionWinStreak
      && i.recentExpectancyR >= T.aggressionMinExpectancyR
      && i.meanCalibrationErrorPp <= T.aggressionMaxCalErrorPp
      && i.trustRungIdx >= T.aggressionMinTrustRungIdx) {
    reasons.push(`win streak ${i.recentWinStreak}, expectancy ${i.recentExpectancyR.toFixed(2)}R, MACE ${i.meanCalibrationErrorPp.toFixed(1)}pp, trust rung ${i.trustRungIdx}`);
    return { mode: "AGGRESSION", reasons };
  }
  reasons.push("conditions normal");
  return { mode: "NORMAL", reasons };
}

// runOrchestration — master entry point. Selects mode, picks strategies,
// computes agent weights, applies mode-specific modifications. Returns a
// single OrchestrationDecision the caller hands to the judge/governor.
export function runOrchestration(
  inputs: OrchestrationInputs,
  strategies: StrategyDescriptor[],
  agents: AgentDescriptor[],
): OrchestrationDecision {
  const reasons: string[] = [];
  const { mode, reasons: modeReasons } = selectMode(inputs);
  reasons.push(`mode=${mode}`, ...modeReasons);

  const stratResult = selectActiveStrategies(strategies, mode, inputs.marketPhaseConfidence01);
  const weights = computeAdaptiveAgentWeights(agents, mode, inputs);

  let decision: OrchestrationDecision = {
    mode,
    activeStrategyIds: stratResult.activeIds,
    agentWeightMultipliers: weights.multipliers,
    globalSizeMultiplier: 1.0,
    minConfidenceThreshold: 60,
    maxConcurrentTrades: 3,
    reasons: [...reasons, ...stratResult.reasons, ...weights.reasons],
  };

  switch (mode) {
    case "DEFENSE":      decision = applyDefenseMode(decision); break;
    case "PRESERVATION": decision = applyPreservationMode(decision); break;
    case "AGGRESSION":   decision = applyAggressionScaling(decision); break;
    case "NORMAL":       break;
  }
  return decision;
}
