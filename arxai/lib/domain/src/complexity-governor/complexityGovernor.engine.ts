import {
  type AgentMetrics, type ComplexityVerdict, type AgentId,
} from "./complexity.types";
import { detectRedundancy } from "./redundancyDetector.engine";
import { reportAgentEfficiency } from "./agentEfficiency.engine";
import { planComputeBudget } from "./computeBudget.engine";
import { evaluateLatencyBudget } from "./latencyBudget.engine";
import { adviseSimplifications } from "./simplificationAdvisor.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Complexity Governor — orchestrates the sub-engines into one verdict.
// forcedDisableAgentIds = union of compute-budget recommendations AND
// efficiency recommendations, FILTERED to never disable ESSENTIAL agents.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ComplexityInput {
  agents: ReadonlyArray<AgentMetrics>;
  totalComputeBudgetMs: number;
  cycleLatenciesMs: ReadonlyArray<number>;
  cycleLatencyBudgetMs: number;
  generatedAtIso: string;
}

export function runComplexityGovernor(input: ComplexityInput): ComplexityVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const efficiency = reportAgentEfficiency({ agents: input.agents });
  const redundancy = detectRedundancy(input.agents);
  const computeBudget = planComputeBudget({ agents: input.agents, totalBudgetMs: input.totalComputeBudgetMs });
  const latencyBudget = evaluateLatencyBudget({ recentCycleLatenciesMs: input.cycleLatenciesMs, budgetMs: input.cycleLatencyBudgetMs });
  const proposals = adviseSimplifications({ efficiency, redundancy, agents: input.agents });

  // Forced disable list — protect ESSENTIAL tier always.
  const essentialIds = new Set(input.agents.filter((a) => a.tier === "ESSENTIAL").map((a) => a.agentId));
  const candidate = new Set<string>([
    ...computeBudget.recommendedDisableAgentIds,
    ...efficiency.filter((e) => e.recommendDisable).map((e) => e.agentId),
  ]);
  const forcedDisable: AgentId[] = [];
  for (const id of candidate) {
    if (essentialIds.has(id)) {
      blockers.push(`refused to disable ESSENTIAL agent ${id}`);
    } else {
      forcedDisable.push(id);
    }
  }
  reasons.push(`forced disable: ${forcedDisable.length} agent(s); essentials protected`);
  if (latencyBudget.recommendDegrade) reasons.push(`latency degrade recommended (p99 ${latencyBudget.observedP99Ms.toFixed(0)}ms)`);
  if (computeBudget.overBudget)        reasons.push(`compute over budget (util ${(computeBudget.utilization01*100).toFixed(0)}%)`);

  return {
    generatedAtIso: input.generatedAtIso,
    efficiency: [...efficiency], redundancy, computeBudget, latencyBudget,
    proposals: [...proposals], forcedDisableAgentIds: forcedDisable, reasons, blockers,
  };
}
