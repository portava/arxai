import {
  type AgentEfficiencyReport, type RedundancyReport,
  type SimplificationProposal, type AgentMetrics,
} from "./complexity.types";

// ═══════════════════════════════════════════════════════════════════════════
// Simplification Advisor — produces proposals (DISABLE/MERGE/REDUCE/DROP)
// from efficiency + redundancy reports. Does not act, only advises. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface SimplificationInput {
  efficiency: ReadonlyArray<AgentEfficiencyReport>;
  redundancy: RedundancyReport;
  agents: ReadonlyArray<AgentMetrics>;
}

export function adviseSimplifications(input: SimplificationInput): ReadonlyArray<SimplificationProposal> {
  const proposals: SimplificationProposal[] = [];
  const cpuByAgent = new Map(input.agents.map((a) => [a.agentId, a.cpuMsPerCycle]));

  // 1) MERGE redundant agents.
  for (const c of input.redundancy.clusters) {
    const cpuSavings = c.agentIds.slice(1).reduce((s, id) => s + (cpuByAgent.get(id) ?? 0), 0);
    proposals.push({
      action: "MERGE_AGENTS", targetAgentIds: c.agentIds,
      expectedSavingsMs: cpuSavings,
      reasons: [`fingerprint cluster ${c.fingerprint} (${c.sampleCount} samples) — keep highest contributor`],
    });
  }
  // 2) DISABLE inefficient non-essentials.
  for (const e of input.efficiency) {
    if (!e.recommendDisable) continue;
    proposals.push({
      action: "DISABLE_AGENT", targetAgentIds: [e.agentId],
      expectedSavingsMs: cpuByAgent.get(e.agentId) ?? 0,
      reasons: [`efficiency ${e.efficiency01.toFixed(2)} → disable`],
    });
  }
  return proposals;
}
