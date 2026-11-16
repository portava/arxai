import {
  type AgentMetrics, type RedundancyReport, type RedundancyCluster,
} from "./complexity.types";

// ═══════════════════════════════════════════════════════════════════════════
// Redundancy Detector — clusters agents that produce identical output
// fingerprints over the same window. The recommended-redundant list keeps
// the agent with the highest uniqueDecisionsContributed; the rest are
// flagged as redundant. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export function detectRedundancy(
  agents: ReadonlyArray<AgentMetrics>, minClusterSize = 2,
): RedundancyReport {
  const reasons: string[] = [];
  // Map fingerprint → set of agent ids that emitted it.
  const fpToAgents = new Map<string, Map<string, number>>();
  for (const a of agents) {
    for (const fp of a.recentOutputFingerprints) {
      const inner = fpToAgents.get(fp) ?? new Map();
      inner.set(a.agentId, (inner.get(a.agentId) ?? 0) + 1);
      fpToAgents.set(fp, inner);
    }
  }
  const clusters: RedundancyCluster[] = [];
  for (const [fp, inner] of fpToAgents) {
    if (inner.size < minClusterSize) continue;
    const agentIds = [...inner.keys()];
    const sampleCount = [...inner.values()].reduce((s, x) => s + x, 0);
    clusters.push({ fingerprint: fp, agentIds, sampleCount });
  }
  // Pick "keeper" per cluster — highest unique contribution.
  const uniqueByAgent = new Map(agents.map((a) => [a.agentId, a.uniqueDecisionsContributed]));
  const redundant = new Set<string>();
  for (const c of clusters) {
    const sortedByContribDesc = [...c.agentIds].sort((a, b) =>
      (uniqueByAgent.get(b) ?? 0) - (uniqueByAgent.get(a) ?? 0));
    for (let i = 1; i < sortedByContribDesc.length; i++) {
      redundant.add(sortedByContribDesc[i]!);
    }
  }
  reasons.push(`${clusters.length} redundancy cluster(s) · ${redundant.size} redundant agent(s)`);
  return { clusters, redundantAgentIds: [...redundant], reasons };
}
