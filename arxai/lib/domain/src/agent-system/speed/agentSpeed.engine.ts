// Agent Ecosystem — Layer 3 Speed Awareness & Self-Step-Back (§11, §21). PURE.
//
// PURPOSE
//   Track per-agent speed/usefulness metrics, decide when an agent should step
//   back (because it is redundant, slow, stale, off-specialty, or low value),
//   and reward CORRECT step-backs so the savings feed Layer 2 scoring. Also
//   defines the structured internal agent-output shape from §21.
//
// SAFETY / SCOPE (inviolable):
//   - INTERNAL / ADVISORY ONLY. Stepping back NEVER blocks or gates execution;
//     it only removes a nonessential agent from a cycle to protect speed. A
//     critical agent (Risk, or a unique decisive contributor) is never told to
//     step back on the live/scalp hot path.
//   - PURE: deterministic, no I/O, no clock, no DB.

import type { AgentRunMode, TrafficMode } from "../traffic/trafficController.engine";

/** The structured internal output every agent emits (§21). Ruby translates it. */
export interface StructuredAgentOutput {
  agentName: string;
  agentId: string;
  mode: AgentRunMode | string;
  status: string;
  decision: "approve" | "caution" | "reject" | "no_trade" | "observe" | "step_back";
  confidence: number; // 0-100
  tradeType: string | null;
  direction: "BUY" | "SELL" | "NEUTRAL" | null;
  entryZone: string | null;
  invalidation: string | null;
  tpSuggestion: string | null;
  riskWarning: string | null;
  reasoningShort: string;
  isUniqueContribution: boolean;
  duplicateOf: string | null;
  speedCostMs: number;
  shouldSpeakToRuby: boolean;
  shouldStepBack: boolean;
  stepBackReason: string | null;
}

/** Lightweight rolling speed/usefulness metrics persisted per agent (§11). */
export interface AgentSpeedMetrics {
  agentKey: string;
  avgRuntimeMs: number;
  lastRuntimeMs: number;
  totalDelayMs: number;
  /** Fraction (0-1) of recent cycles where the agent changed the final decision. */
  changedDecisionRate: number;
  /** Fraction (0-1) of recent cycles where the agent duplicated another. */
  duplicateAnalysisRate: number;
  /** Usefulness points produced per millisecond of runtime. */
  usefulnessPerMs: number;
  /** 0-100; higher = more expensive relative to its value. */
  speedCostScore: number;
  /** How many times the agent has stepped back. */
  stepBackCount: number;
  correctStepBackCount: number;
}

/**
 * Fold one cycle's runtime + a usefulness signal into rolling metrics.
 * `usefulness01` is a 0-1 measure of how much value this run added
 * (0 = pure noise, 1 = decisive). Pure — caller owns the prior metrics.
 */
export function updateSpeedMetrics(
  prior: AgentSpeedMetrics,
  cycle: {
    runtimeMs: number;
    changedDecision: boolean;
    wasDuplicate: boolean;
    usefulness01: number;
    sampleWeight?: number; // smoothing weight for the new sample (0-1), default 0.3
  },
): AgentSpeedMetrics {
  const w = clamp01(cycle.sampleWeight ?? 0.3);
  const runtime = Math.max(0, cycle.runtimeMs);
  const avgRuntimeMs = +(prior.avgRuntimeMs * (1 - w) + runtime * w).toFixed(2);
  const changedDecisionRate = +(prior.changedDecisionRate * (1 - w) + (cycle.changedDecision ? 1 : 0) * w).toFixed(4);
  const duplicateAnalysisRate = +(prior.duplicateAnalysisRate * (1 - w) + (cycle.wasDuplicate ? 1 : 0) * w).toFixed(4);
  const usefulnessPerMs = +(clamp01(cycle.usefulness01) / Math.max(runtime, 1)).toFixed(6);
  return {
    agentKey: prior.agentKey,
    avgRuntimeMs,
    lastRuntimeMs: runtime,
    totalDelayMs: +(prior.totalDelayMs + runtime).toFixed(2),
    changedDecisionRate,
    duplicateAnalysisRate,
    usefulnessPerMs,
    speedCostScore: computeSpeedCostScore({ avgRuntimeMs, usefulnessPerMs, duplicateAnalysisRate }),
    stepBackCount: prior.stepBackCount,
    correctStepBackCount: prior.correctStepBackCount,
  };
}

/**
 * Speed-cost score 0-100: high runtime, low usefulness-per-ms, and high
 * duplicate rate all push it up (expensive relative to value).
 */
export function computeSpeedCostScore(m: {
  avgRuntimeMs: number;
  usefulnessPerMs: number;
  duplicateAnalysisRate: number;
}): number {
  // Runtime component: 0ms→0, 500ms+→~60.
  const runtimeComponent = Math.min(60, (m.avgRuntimeMs / 500) * 60);
  // Low usefulness-per-ms adds up to 25. (0.002/ms is "good".)
  const valueComponent = Math.max(0, 25 - Math.min(25, m.usefulnessPerMs * 12500));
  const duplicateComponent = clamp01(m.duplicateAnalysisRate) * 15;
  return +Math.min(100, runtimeComponent + valueComponent + duplicateComponent).toFixed(2);
}

export type StepBackMode =
  | "FAST_MODE" | "SILENT_SUPPORT" | "ON_DEMAND" | "SLEEPING" | "BACKGROUND" | "ARCHIVED";

export interface StepBackEvaluationInput {
  agentKey: string;
  department: string;
  /** Departments relevant to the surface/decision right now. */
  relevantDepartments: readonly string[];
  metrics: AgentSpeedMetrics;
  /** True when this cycle's analysis duplicates another agent. */
  isDuplicate: boolean;
  /** True when another agent is strictly better suited for this decision. */
  betterAgentAvailable?: boolean;
  /** Age of this agent's underlying analysis in ms (staleness). */
  analysisAgeMs?: number;
  /** Current operating mode — speed-critical modes raise the bar. */
  mode: TrafficMode;
  /** True if this agent is the unique decisive contributor (never step back). */
  isDecisiveUnique?: boolean;
  /** Risk agents protecting capital never step back. */
  isProtective?: boolean;
}

export interface StepBackEvaluation {
  shouldStepBack: boolean;
  reason: string | null;
  recommendedMode: StepBackMode | null;
  /** Machine codes for every rule that fired (for admin trace). */
  triggers: string[];
}

const SPEED_CRITICAL_MODES = new Set<TrafficMode>(["LIVE_EXECUTION", "SCALP"]);
const STALE_MS = 60_000;

/**
 * Decide whether an agent should self-step-back this cycle (§11). Protective
 * agents (Risk) and the unique decisive contributor never step back. Otherwise
 * redundancy, off-specialty, staleness, slowness in a speed-critical mode, low
 * usefulness, or a better-suited peer each trigger a step-back.
 */
export function evaluateStepBack(input: StepBackEvaluationInput): StepBackEvaluation {
  const triggers: string[] = [];

  // Hard guards: never tell a protective or uniquely-decisive agent to step back.
  if (input.isProtective || input.isDecisiveUnique) {
    return { shouldStepBack: false, reason: null, recommendedMode: null, triggers };
  }

  const relevant = new Set(input.relevantDepartments.map((d) => d.toUpperCase()));
  const offSpecialty = relevant.size > 0 && !relevant.has(input.department.toUpperCase());
  const speedCritical = SPEED_CRITICAL_MODES.has(input.mode);
  const stale = (input.analysisAgeMs ?? 0) > STALE_MS;
  const lowUsefulness = input.metrics.changedDecisionRate < 0.1 && input.metrics.usefulnessPerMs < 0.0005;
  const slowingExecution = speedCritical && input.metrics.speedCostScore >= 55;

  if (input.isDuplicate) triggers.push("redundant_duplicate_analysis");
  if (offSpecialty) triggers.push("outside_specialty");
  if (stale) triggers.push("stale_analysis");
  if (slowingExecution) triggers.push("slowing_live_execution");
  if (lowUsefulness) triggers.push("low_recent_usefulness");
  if (input.betterAgentAvailable) triggers.push("another_agent_better_suited");
  if (speedCritical && offSpecialty) triggers.push("mode_requires_speed");

  if (triggers.length === 0) {
    return { shouldStepBack: false, reason: null, recommendedMode: null, triggers };
  }

  // Pick a recommended step-back mode by severity.
  let recommendedMode: StepBackMode;
  if (input.isDuplicate || offSpecialty) recommendedMode = "SILENT_SUPPORT";
  else if (slowingExecution) recommendedMode = "FAST_MODE";
  else if (lowUsefulness) recommendedMode = "ON_DEMAND";
  else recommendedMode = "SILENT_SUPPORT";

  return {
    shouldStepBack: true,
    reason: triggers[0]!,
    recommendedMode,
    triggers,
  };
}

export interface StepBackReward {
  /** True when the step-back was the right call (no decisive contribution lost). */
  correct: boolean;
  /** Bounded reward/penalty deltas (points) for Layer 2 scoring. */
  speedScoreDelta: number;
  usefulnessScoreDelta: number;
  reason: string;
}

/**
 * Score a step-back AFTER the cycle resolved (§11 "rewarded for stepping back
 * correctly"; feeds Layer 2). A step-back is CORRECT when the agent would not
 * have changed the final decision (it was redundant / low value) — that earns a
 * small speed + usefulness reward. A step-back that dropped a decisive unique
 * contribution is INCORRECT and earns a small penalty.
 */
export function rewardStepBack(args: {
  steppedBack: boolean;
  wouldHaveChangedDecision: boolean;
  wasUniqueContribution: boolean;
}): StepBackReward {
  if (!args.steppedBack) {
    return { correct: false, speedScoreDelta: 0, usefulnessScoreDelta: 0, reason: "no_step_back" };
  }
  // Dropping a decisive, unique contribution is a bad step-back.
  if (args.wouldHaveChangedDecision && args.wasUniqueContribution) {
    return {
      correct: false,
      speedScoreDelta: -1,
      usefulnessScoreDelta: -2,
      reason: "stepped_back_on_decisive_unique_contribution",
    };
  }
  // Correct step-back: removed redundant/low-value work, protected speed.
  return {
    correct: true,
    speedScoreDelta: 2,
    usefulnessScoreDelta: 1,
    reason: "correct_step_back_protected_speed",
  };
}

export function initSpeedMetrics(agentKey: string): AgentSpeedMetrics {
  return {
    agentKey,
    avgRuntimeMs: 0,
    lastRuntimeMs: 0,
    totalDelayMs: 0,
    changedDecisionRate: 0,
    duplicateAnalysisRate: 0,
    usefulnessPerMs: 0,
    speedCostScore: 0,
    stepBackCount: 0,
    correctStepBackCount: 0,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
