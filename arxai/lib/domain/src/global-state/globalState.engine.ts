import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Global State Machine — STATES + PROFILES
// Self-contained subdomain. Defines the 14 unified operational states that
// govern the entire AI Trading OS, and the per-state profile (allowed
// strategies, aggression, risk multiplier, validation strictness, UI
// attention behavior, execution permissions). Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const GlobalStateSchema = z.enum([
  "NORMAL",
  "HIGH_VOLATILITY",
  "TREND_EXPANSION",
  "CHOP_DANGER",
  "NEWS_RISK",
  "LOW_LIQUIDITY",
  "EXECUTION_RISK",
  "COGNITIVE_FATIGUE",
  "RECOVERY_MODE",
  "DEFENSIVE_MODE",
  "PRESERVATION_MODE",
  "DEGRADED_MODE",
  "LOCKDOWN",
  "SAFE_SHUTDOWN",
]);
export type GlobalState = z.infer<typeof GlobalStateSchema>;

export const StrategyKindSchema = z.enum([
  "TREND_CONTINUATION", "BREAK_OF_STRUCTURE", "LIQUIDITY_SWEEP",
  "VOLATILITY_EXPANSION", "MEAN_REVERT", "DEFENSIVE_HEDGE", "NO_TRADE_FILTER",
]);
export type StrategyKind = z.infer<typeof StrategyKindSchema>;

export const ValidationStrictnessSchema = z.enum(["NORMAL", "STRICT", "MAX"]);
export type ValidationStrictness = z.infer<typeof ValidationStrictnessSchema>;

export const AttentionBehaviorSchema = z.enum(["NORMAL", "ELEVATED", "DANGER", "CRITICAL"]);
export type AttentionBehavior = z.infer<typeof AttentionBehaviorSchema>;

export const ExecutionPermissionSchema = z.enum([
  "FULL",         // open + scale + close
  "REDUCED",      // open with size cut + scale + close
  "CLOSE_ONLY",   // no new entries, manage / close existing
  "NONE",         // no orders at all
]);
export type ExecutionPermission = z.infer<typeof ExecutionPermissionSchema>;

export const StateProfileSchema = z.object({
  state: GlobalStateSchema,
  allowedStrategies: z.array(StrategyKindSchema),
  allowedAggression01: z.number().min(0).max(1.5),
  riskMultiplier01: z.number().min(0).max(1),
  validationStrictness: ValidationStrictnessSchema,
  uiAttentionBehavior: AttentionBehaviorSchema,
  executionPermission: ExecutionPermissionSchema,
  description: z.string(),
});
export type StateProfile = z.infer<typeof StateProfileSchema>;

const ALL_STRATEGIES: ReadonlyArray<StrategyKind> = [
  "TREND_CONTINUATION", "BREAK_OF_STRUCTURE", "LIQUIDITY_SWEEP",
  "VOLATILITY_EXPANSION", "MEAN_REVERT", "DEFENSIVE_HEDGE", "NO_TRADE_FILTER",
];
const TREND_ONLY: ReadonlyArray<StrategyKind> = [
  "TREND_CONTINUATION", "BREAK_OF_STRUCTURE", "VOLATILITY_EXPANSION",
];
const DEFENSIVE_ONLY: ReadonlyArray<StrategyKind> = ["DEFENSIVE_HEDGE", "NO_TRADE_FILTER"];
const NO_TRADE_ONLY: ReadonlyArray<StrategyKind> = ["NO_TRADE_FILTER"];

export const STATE_PROFILES: Readonly<Record<GlobalState, StateProfile>> = {
  NORMAL: {
    state: "NORMAL", allowedStrategies: [...ALL_STRATEGIES],
    allowedAggression01: 1.0, riskMultiplier01: 1.0,
    validationStrictness: "NORMAL", uiAttentionBehavior: "NORMAL",
    executionPermission: "FULL", description: "Standard operations.",
  },
  HIGH_VOLATILITY: {
    state: "HIGH_VOLATILITY",
    allowedStrategies: ["TREND_CONTINUATION", "BREAK_OF_STRUCTURE", "VOLATILITY_EXPANSION", "DEFENSIVE_HEDGE", "NO_TRADE_FILTER"],
    allowedAggression01: 0.7, riskMultiplier01: 0.8,
    validationStrictness: "STRICT", uiAttentionBehavior: "ELEVATED",
    executionPermission: "FULL", description: "Volatility expanded — favor breakout / trend strategies, smaller size.",
  },
  TREND_EXPANSION: {
    state: "TREND_EXPANSION", allowedStrategies: [...TREND_ONLY, "DEFENSIVE_HEDGE"],
    allowedAggression01: 1.2, riskMultiplier01: 1.0,
    validationStrictness: "NORMAL", uiAttentionBehavior: "NORMAL",
    executionPermission: "FULL", description: "Strong directional move — let winners run.",
  },
  CHOP_DANGER: {
    state: "CHOP_DANGER", allowedStrategies: ["MEAN_REVERT", "NO_TRADE_FILTER"],
    allowedAggression01: 0.4, riskMultiplier01: 0.5,
    validationStrictness: "STRICT", uiAttentionBehavior: "ELEVATED",
    executionPermission: "REDUCED", description: "Range-bound chop — avoid trend strategies, size reduced.",
  },
  NEWS_RISK: {
    state: "NEWS_RISK", allowedStrategies: [...DEFENSIVE_ONLY],
    allowedAggression01: 0.3, riskMultiplier01: 0.4,
    validationStrictness: "STRICT", uiAttentionBehavior: "DANGER",
    executionPermission: "REDUCED", description: "High-impact news window — defensive only.",
  },
  LOW_LIQUIDITY: {
    state: "LOW_LIQUIDITY", allowedStrategies: ["TREND_CONTINUATION", "DEFENSIVE_HEDGE", "NO_TRADE_FILTER"],
    allowedAggression01: 0.5, riskMultiplier01: 0.6,
    validationStrictness: "STRICT", uiAttentionBehavior: "ELEVATED",
    executionPermission: "REDUCED", description: "Thin book — limit-only entries, smaller size.",
  },
  EXECUTION_RISK: {
    state: "EXECUTION_RISK", allowedStrategies: ["TREND_CONTINUATION", "DEFENSIVE_HEDGE", "NO_TRADE_FILTER"],
    allowedAggression01: 0.4, riskMultiplier01: 0.5,
    validationStrictness: "STRICT", uiAttentionBehavior: "ELEVATED",
    executionPermission: "REDUCED", description: "Spreads / slippage / fills degraded — execution gated.",
  },
  COGNITIVE_FATIGUE: {
    state: "COGNITIVE_FATIGUE", allowedStrategies: ["TREND_CONTINUATION", "DEFENSIVE_HEDGE", "NO_TRADE_FILTER"],
    allowedAggression01: 0.5, riskMultiplier01: 0.6,
    validationStrictness: "STRICT", uiAttentionBehavior: "ELEVATED",
    executionPermission: "REDUCED", description: "Trader fatigue elevated — fewer setups, smaller size.",
  },
  RECOVERY_MODE: {
    state: "RECOVERY_MODE", allowedStrategies: [...DEFENSIVE_ONLY],
    allowedAggression01: 0.3, riskMultiplier01: 0.4,
    validationStrictness: "STRICT", uiAttentionBehavior: "DANGER",
    executionPermission: "REDUCED", description: "Recovering from drawdown / cognitive load — defensive only.",
  },
  DEFENSIVE_MODE: {
    state: "DEFENSIVE_MODE", allowedStrategies: [...DEFENSIVE_ONLY],
    allowedAggression01: 0.4, riskMultiplier01: 0.5,
    validationStrictness: "STRICT", uiAttentionBehavior: "ELEVATED",
    executionPermission: "REDUCED", description: "High agent disagreement — defensive only.",
  },
  PRESERVATION_MODE: {
    state: "PRESERVATION_MODE", allowedStrategies: [...NO_TRADE_ONLY],
    allowedAggression01: 0.0, riskMultiplier01: 0.2,
    validationStrictness: "MAX", uiAttentionBehavior: "DANGER",
    executionPermission: "CLOSE_ONLY", description: "Capital preservation — no new entries, manage existing.",
  },
  DEGRADED_MODE: {
    state: "DEGRADED_MODE", allowedStrategies: [...DEFENSIVE_ONLY],
    allowedAggression01: 0.3, riskMultiplier01: 0.4,
    validationStrictness: "MAX", uiAttentionBehavior: "DANGER",
    executionPermission: "REDUCED", description: "Infrastructure degraded — limited operations.",
  },
  LOCKDOWN: {
    state: "LOCKDOWN", allowedStrategies: [],
    allowedAggression01: 0.0, riskMultiplier01: 0.0,
    validationStrictness: "MAX", uiAttentionBehavior: "CRITICAL",
    executionPermission: "NONE", description: "Lockdown — no orders sent. Manual intervention required.",
  },
  SAFE_SHUTDOWN: {
    state: "SAFE_SHUTDOWN", allowedStrategies: [],
    allowedAggression01: 0.0, riskMultiplier01: 0.0,
    validationStrictness: "MAX", uiAttentionBehavior: "CRITICAL",
    executionPermission: "CLOSE_ONLY", description: "Safe shutdown — close existing then halt.",
  },
};

export function getStateProfile(state: GlobalState): StateProfile {
  return STATE_PROFILES[state];
}

// Conservative intersection of two profiles' allowed strategies (for primary
// + secondary substate composition).
export function intersectProfiles(primary: StateProfile, secondary: StateProfile): StateProfile {
  const allowedSet = new Set(secondary.allowedStrategies);
  const allowedStrategies = primary.allowedStrategies.filter((s) => allowedSet.has(s));
  const validationOrder: Record<ValidationStrictness, number> = { NORMAL: 0, STRICT: 1, MAX: 2 };
  const attentionOrder: Record<AttentionBehavior, number>     = { NORMAL: 0, ELEVATED: 1, DANGER: 2, CRITICAL: 3 };
  const execOrder: Record<ExecutionPermission, number>        = { FULL: 3, REDUCED: 2, CLOSE_ONLY: 1, NONE: 0 };
  const pickStricterValidation = (a: ValidationStrictness, b: ValidationStrictness) =>
    validationOrder[a] >= validationOrder[b] ? a : b;
  const pickHigherAttention = (a: AttentionBehavior, b: AttentionBehavior) =>
    attentionOrder[a] >= attentionOrder[b] ? a : b;
  const pickStricterExec = (a: ExecutionPermission, b: ExecutionPermission) =>
    execOrder[a] <= execOrder[b] ? a : b;
  return {
    state: primary.state,
    allowedStrategies,
    allowedAggression01: Math.min(primary.allowedAggression01, secondary.allowedAggression01),
    riskMultiplier01:    Math.min(primary.riskMultiplier01,    secondary.riskMultiplier01),
    validationStrictness: pickStricterValidation(primary.validationStrictness, secondary.validationStrictness),
    uiAttentionBehavior:  pickHigherAttention(primary.uiAttentionBehavior, secondary.uiAttentionBehavior),
    executionPermission:  pickStricterExec(primary.executionPermission, secondary.executionPermission),
    description: `${primary.description} (substate: ${secondary.state})`,
  };
}
