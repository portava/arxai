import {
  type AgentMetrics, type ComputeBudgetReport, type AgentId, clamp01,
} from "./complexity.types";

// ═══════════════════════════════════════════════════════════════════════════
// Compute Budget — sums per-agent CPU consumption and disables the
// lowest-tier / least-efficient OPTIONAL/EXPERIMENTAL agents until under
// budget. ESSENTIAL agents are never disabled by this engine. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ComputeBudgetInput {
  agents: ReadonlyArray<AgentMetrics>;
  totalBudgetMs: number;
}

const TIER_ORDER = { EXPERIMENTAL: 0, OPTIONAL: 1, RECOMMENDED: 2, ESSENTIAL: 3 } as const;

export function planComputeBudget(input: ComputeBudgetInput): ComputeBudgetReport {
  const reasons: string[] = [];
  const budget = Math.max(1, input.totalBudgetMs);
  const consumed = input.agents.reduce((s, a) => s + a.cpuMsPerCycle, 0);
  const utilization01 = clamp01(consumed / budget);
  const overBudget = consumed > budget;
  reasons.push(`consumed ${consumed.toFixed(1)}ms / budget ${budget}ms → util ${(utilization01*100).toFixed(0)}%`);

  const disable: AgentId[] = [];
  if (overBudget) {
    // Sort: lowest tier first, then highest cpu (most expensive disposables).
    const candidates = input.agents
      .filter((a) => a.tier !== "ESSENTIAL")
      .sort((a, b) =>
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
        || b.cpuMsPerCycle - a.cpuMsPerCycle);
    let remaining = consumed;
    for (const c of candidates) {
      if (remaining <= budget) break;
      disable.push(c.agentId);
      remaining -= c.cpuMsPerCycle;
      reasons.push(`disable ${c.agentId} (tier ${c.tier}, ${c.cpuMsPerCycle.toFixed(1)}ms) — remaining ${remaining.toFixed(1)}ms`);
    }
    if (remaining > budget) {
      reasons.push(`unable to reach budget by disabling non-essentials — ${remaining.toFixed(1)}ms still over`);
    }
  }
  return {
    totalBudgetMs: budget, consumedMs: consumed, utilization01, overBudget,
    recommendedDisableAgentIds: disable, reasons,
  };
}
