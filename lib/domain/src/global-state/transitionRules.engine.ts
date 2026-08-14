import { z } from "zod/v4";
import { GlobalStateSchema, type GlobalState } from "./globalState.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Transition Rules — maps signals from each subsystem (risk governor, control
// tower, resilience, cognitive, judge disagreement, market regime, exec
// micro, etc.) to the GlobalState it demands. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const TransitionSourceSchema = z.enum([
  "RISK_GOVERNOR", "CONTROL_TOWER", "RESILIENCE", "COGNITIVE",
  "JUDGE_DISAGREEMENT", "MARKET_DANGER", "MARKET_REGIME",
  "EXECUTION_MICROSTRUCTURE", "LIQUIDITY", "NEWS_CALENDAR",
]);
export type TransitionSource = z.infer<typeof TransitionSourceSchema>;

export const Score01Schema = z.number().min(0).max(1);
export type Score01 = z.infer<typeof Score01Schema>;

export const TransitionDemandSchema = z.object({
  source: TransitionSourceSchema,
  demandedState: GlobalStateSchema,
  reason: z.string(),
  forced: z.boolean(),     // true = source has authority to override (Risk Gov, Control Tower, Resilience, Cognitive, etc.)
});
export type TransitionDemand = z.infer<typeof TransitionDemandSchema>;

export const TransitionInputsSchema = z.object({
  // Force-capable signals
  riskGovernorForcedState:    GlobalStateSchema.nullable(),
  controlTowerForcedState:    GlobalStateSchema.nullable(),
  resilienceForcedShutdown:   z.boolean(),     // → SAFE_SHUTDOWN
  resilienceForcedDegraded:   z.boolean(),     // → DEGRADED_MODE
  cognitiveForcedRecovery:    z.boolean(),     // → RECOVERY_MODE
  cognitiveFatigueHigh:       z.boolean(),     // → COGNITIVE_FATIGUE
  judgeDisagreement01:        Score01Schema,   // ≥ 0.7 → DEFENSIVE_MODE
  marketDanger01:             Score01Schema,   // ≥ 0.8 → PRESERVATION_MODE

  // Soft signals (best-of)
  marketRegime: z.enum(["NORMAL", "TREND", "CHOP", "VOLATILE"]),
  newsRiskActive:             z.boolean(),     // → NEWS_RISK
  liquidityLow:               z.boolean(),     // → LOW_LIQUIDITY
  executionRiskHigh:          z.boolean(),     // → EXECUTION_RISK
});
export type TransitionInputs = z.infer<typeof TransitionInputsSchema>;

export function deriveDemands(input: TransitionInputs): TransitionDemand[] {
  const demands: TransitionDemand[] = [];

  // Highest authority — Risk Governor & Control Tower can name any state.
  if (input.riskGovernorForcedState !== null) {
    demands.push({ source: "RISK_GOVERNOR", demandedState: input.riskGovernorForcedState,
      reason: "risk governor forced state", forced: true });
  }
  if (input.controlTowerForcedState !== null) {
    demands.push({ source: "CONTROL_TOWER", demandedState: input.controlTowerForcedState,
      reason: "control tower forced state", forced: true });
  }

  // Resilience — DEGRADED_MODE or SAFE_SHUTDOWN.
  if (input.resilienceForcedShutdown) {
    demands.push({ source: "RESILIENCE", demandedState: "SAFE_SHUTDOWN",
      reason: "resilience demands safe shutdown", forced: true });
  } else if (input.resilienceForcedDegraded) {
    demands.push({ source: "RESILIENCE", demandedState: "DEGRADED_MODE",
      reason: "resilience reports degraded infrastructure", forced: true });
  }

  // Cognitive — RECOVERY_MODE (forced) or COGNITIVE_FATIGUE (soft).
  if (input.cognitiveForcedRecovery) {
    demands.push({ source: "COGNITIVE", demandedState: "RECOVERY_MODE",
      reason: "cognitive engine demands recovery", forced: true });
  } else if (input.cognitiveFatigueHigh) {
    demands.push({ source: "COGNITIVE", demandedState: "COGNITIVE_FATIGUE",
      reason: "trader fatigue elevated", forced: false });
  }

  // High disagreement → DEFENSIVE_MODE.
  if (input.judgeDisagreement01 >= 0.7) {
    demands.push({ source: "JUDGE_DISAGREEMENT", demandedState: "DEFENSIVE_MODE",
      reason: `judge disagreement ${(input.judgeDisagreement01*100).toFixed(0)}% ≥ 70%`,
      forced: true });
  }

  // High market danger → PRESERVATION_MODE.
  if (input.marketDanger01 >= 0.8) {
    demands.push({ source: "MARKET_DANGER", demandedState: "PRESERVATION_MODE",
      reason: `market danger ${(input.marketDanger01*100).toFixed(0)}% ≥ 80%`,
      forced: true });
  }

  // Soft regime mapping.
  switch (input.marketRegime) {
    case "TREND":
      demands.push({ source: "MARKET_REGIME", demandedState: "TREND_EXPANSION",
        reason: "market regime: trend", forced: false });
      break;
    case "VOLATILE":
      demands.push({ source: "MARKET_REGIME", demandedState: "HIGH_VOLATILITY",
        reason: "market regime: high volatility", forced: false });
      break;
    case "CHOP":
      demands.push({ source: "MARKET_REGIME", demandedState: "CHOP_DANGER",
        reason: "market regime: chop", forced: false });
      break;
    case "NORMAL": break;
  }

  if (input.newsRiskActive) {
    demands.push({ source: "NEWS_CALENDAR", demandedState: "NEWS_RISK",
      reason: "high-impact news window", forced: false });
  }
  if (input.liquidityLow) {
    demands.push({ source: "LIQUIDITY", demandedState: "LOW_LIQUIDITY",
      reason: "liquidity low", forced: false });
  }
  if (input.executionRiskHigh) {
    demands.push({ source: "EXECUTION_MICROSTRUCTURE", demandedState: "EXECUTION_RISK",
      reason: "execution micro deteriorated", forced: false });
  }

  if (demands.length === 0) {
    demands.push({ source: "MARKET_REGIME", demandedState: "NORMAL",
      reason: "no abnormal signals", forced: false });
  }
  return demands;
}

// Whether transitioning from `from` to `to` requires explicit force.
// SAFE_SHUTDOWN is terminal — only RESILIENCE / RISK_GOVERNOR / CONTROL_TOWER may exit.
export function requiresForceToExit(from: GlobalState): boolean {
  return from === "SAFE_SHUTDOWN" || from === "LOCKDOWN";
}

const FORCE_CAPABLE = new Set<TransitionSource>([
  "RISK_GOVERNOR", "CONTROL_TOWER", "RESILIENCE", "COGNITIVE",
  "JUDGE_DISAGREEMENT", "MARKET_DANGER",
]);

export function isForceCapable(source: TransitionSource): boolean {
  return FORCE_CAPABLE.has(source);
}
