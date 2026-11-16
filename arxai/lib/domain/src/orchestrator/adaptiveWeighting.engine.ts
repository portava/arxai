import type { OrchestrationInputs, OrchestrationMode } from "./orchestrator.engine";

export interface AgentDescriptor {
  agentId: string;
  baseWeight: number;
  contextRelevance01: number;           // 0..1 — how relevant this agent is now
  isRiskAgent?: boolean;                // risk/danger-flagging agents are upweighted in DEFENSE/PRESERVATION
}

export interface AdaptiveWeightingResult {
  multipliers: Record<string, number>;  // agentId → multiplier vs base
  reasons: string[];
}

// computeAdaptiveAgentWeights — apply a multiplier per agent based on
// (a) its contextRelevance and (b) the current orchestration mode.
//
// Mode policies:
//   NORMAL       — pass-through (multiplier ≈ contextRelevance)
//   DEFENSE      — risk agents 1.5×, others contextRelevance × 0.85
//   PRESERVATION — risk agents 2.0×, others contextRelevance × 0.50
//   AGGRESSION   — risk agents 1.0×, others contextRelevance × 1.15
//
// Final multiplier clamped to [0, 2.5] to bound any single agent's authority.
export function computeAdaptiveAgentWeights(
  agents: AgentDescriptor[],
  mode: OrchestrationMode,
  _inputs: OrchestrationInputs,
): AdaptiveWeightingResult {
  const reasons: string[] = [`adaptive weighting under mode=${mode}`];
  const multipliers: Record<string, number> = {};
  for (const a of agents) {
    const rel = Math.max(0, Math.min(1, a.contextRelevance01));
    let m: number;
    switch (mode) {
      case "NORMAL":       m = rel; break;
      case "DEFENSE":      m = a.isRiskAgent ? 1.5 : rel * 0.85; break;
      case "PRESERVATION": m = a.isRiskAgent ? 2.0 : rel * 0.50; break;
      case "AGGRESSION":   m = a.isRiskAgent ? 1.0 : rel * 1.15; break;
    }
    multipliers[a.agentId] = Math.max(0, Math.min(2.5, m));
  }
  return { multipliers, reasons };
}
