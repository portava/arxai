import type { AgentSystemSnapshot, QualityVerdict } from "../agentSystem.types";

// Historical Match Agent — quality score from win-rate of similar past
// setups, weighted by sample-size × similarity. Low trust blends to neutral 50.
export function historicalMatchAgent(snap: AgentSystemSnapshot): QualityVerdict {
  const reasons: string[] = [];
  const h = snap.policy.historicalMatches;

  if (h.matchCount === 0) {
    reasons.push("no historical matches — neutral 50");
    return {
      agentId: "HIST", agentName: "Historical Match Agent", category: "QUALITY",
      qualityScore: 50, reasons, observedAt: snap.now.toISOString(),
    };
  }

  const sampleConfidence01 = Math.min(Math.sqrt(h.matchCount) / Math.sqrt(30), 1);
  const trust01 = sampleConfidence01 * h.averageSimilarity01;
  const winRateScore = h.winRate01 * 100;
  const score = winRateScore * trust01 + 50 * (1 - trust01);

  reasons.push(
    `${h.matchCount} matches @ ${(h.winRate01 * 100).toFixed(0)}% win, ` +
    `avg ${h.averagePnlR.toFixed(2)}R, similarity ${h.averageSimilarity01.toFixed(2)} ` +
    `→ quality ${score.toFixed(0)} (trust ${trust01.toFixed(2)})`,
  );

  return {
    agentId: "HIST", agentName: "Historical Match Agent", category: "QUALITY",
    qualityScore: Math.max(0, Math.min(100, score)), reasons,
    observedAt: snap.now.toISOString(),
  };
}
