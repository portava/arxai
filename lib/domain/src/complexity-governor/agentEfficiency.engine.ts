import {
  type AgentMetrics, type AgentEfficiencyReport, clamp01,
} from "./complexity.types";

// ═══════════════════════════════════════════════════════════════════════════
// Agent Efficiency — efficiency = contribution / cost.
//   contribution01 = uniqueDecisionsContributed / max(decisionsObserved, 1)
//   cost01 = clamp01((cpuMs/cpuRef + mem/memRef) / 2)
//   efficiency = clamp01(contribution / max(cost, 0.05))   capped at 1
//   recommendDisable when:
//     • tier ≠ ESSENTIAL AND efficiency < 0.20 AND decisionsObserved ≥ minN
//     OR errorRate ≥ 0.30
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface EfficiencyInput {
  agents: ReadonlyArray<AgentMetrics>;
  cpuRefMs?: number;          // default 50
  memRefMb?: number;          // default 256
  minSampleN?: number;        // default 20
}

export function reportAgentEfficiency(input: EfficiencyInput): ReadonlyArray<AgentEfficiencyReport> {
  const cpuRef = input.cpuRefMs ?? 50;
  const memRef = input.memRefMb ?? 256;
  const minN = input.minSampleN ?? 20;

  return input.agents.map((a) => {
    const reasons: string[] = [];
    const contribution01 = clamp01(a.uniqueDecisionsContributed / Math.max(1, a.decisionsObserved));
    const cost01 = clamp01((a.cpuMsPerCycle / cpuRef + a.memoryMb / memRef) / 2);
    const efficiency01 = clamp01(contribution01 / Math.max(0.05, cost01));
    let recommendDisable = false;
    if (a.tier !== "ESSENTIAL" && efficiency01 < 0.20 && a.decisionsObserved >= minN) {
      recommendDisable = true;
      reasons.push(`tier ${a.tier} · efficiency ${efficiency01.toFixed(2)} < 0.20 with n=${a.decisionsObserved}`);
    }
    if (a.errorRate01 >= 0.30) {
      recommendDisable = true;
      reasons.push(`errorRate ${(a.errorRate01*100).toFixed(0)}% ≥ 30%`);
    }
    reasons.push(`contribution ${contribution01.toFixed(2)} / cost ${cost01.toFixed(2)} → efficiency ${efficiency01.toFixed(2)}`);
    return {
      agentId: a.agentId, efficiency01,
      costScore01: cost01, contributionScore01: contribution01,
      recommendDisable, reasons,
    };
  });
}
