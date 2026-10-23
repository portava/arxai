import type { AgentSystemSnapshot, DirectionVerdict } from "../agentSystem.types";

// Market Structure Agent — votes from the most-recent break of structure.
// No recent BOS recorded → abstain rather than guess.
export function marketStructureAgent(snap: AgentSystemSnapshot): DirectionVerdict {
  const reasons: string[] = [];
  const bos = snap.market.recentStructureBreak;
  if (bos === null) {
    reasons.push("no recent break of structure — abstain");
    return {
      agentId: "STRUCT", agentName: "Market Structure Agent", category: "DIRECTION",
      direction: "ABSTAIN", conviction: 0, reasons, observedAt: snap.now.toISOString(),
    };
  }
  reasons.push(`recent BOS to the ${bos} side → vote ${bos} @ 70`);
  return {
    agentId: "STRUCT", agentName: "Market Structure Agent", category: "DIRECTION",
    direction: bos, conviction: 70, reasons, observedAt: snap.now.toISOString(),
  };
}
