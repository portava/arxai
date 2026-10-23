import type { AgentSystemSnapshot, HardBlockVerdict } from "../agentSystem.types";

// Trader DNA Agent — guards the operator from themselves.
// Watches tilt, revenge-trade pattern, cooldown after loss.
export function traderDnaAgent(snap: AgentSystemSnapshot): HardBlockVerdict {
  const reasons: string[] = [];
  const b = snap.behavior;
  const p = snap.policy;
  let vetoReason: string | null = null;

  if (b.emotionalState === "TILT") {
    vetoReason = "operator state is TILT — emotional override blocks all entries";
  } else if (b.consecutiveLosses >= p.maxConsecutiveLossesBeforeBlock) {
    vetoReason = `${b.consecutiveLosses} consecutive losses ≥ block threshold ${p.maxConsecutiveLossesBeforeBlock}`;
  } else if (b.minutesSinceLastTrade !== null
             && b.consecutiveLosses > 0
             && b.minutesSinceLastTrade < p.cooldownMinutesAfterLoss) {
    vetoReason = `cooldown active — ${b.minutesSinceLastTrade}m < ${p.cooldownMinutesAfterLoss}m required after loss`;
  }

  reasons.push(vetoReason
    ? `VETO: ${vetoReason}`
    : `operator ${b.emotionalState}, ${b.consecutiveLosses} recent losses, cooldown clear`);

  return {
    agentId: "DNA", agentName: "Trader DNA Agent", category: "HARD_BLOCK",
    vetoed: vetoReason !== null, vetoReason, reasons,
    observedAt: snap.now.toISOString(),
  };
}
