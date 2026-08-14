import type { AgentSystemSnapshot, DirectionVerdict } from "../agentSystem.types";

// Momentum Agent — votes from short-frame signed momentum ONLY.
export function momentumAgent(snap: AgentSystemSnapshot): DirectionVerdict {
  const reasons: string[] = [];
  const m = snap.market.momentumSigned;
  let direction: DirectionVerdict["direction"];
  let conviction: number;

  const mag = Math.min(Math.abs(m), 1) * 100;
  if (m >= 0.15) {
    direction = "BUY";
    conviction = Math.max(30, Math.min(100, mag));
    reasons.push(`momentum +${m.toFixed(2)} → BUY @ ${conviction.toFixed(0)}`);
  } else if (m <= -0.15) {
    direction = "SELL";
    conviction = Math.max(30, Math.min(100, mag));
    reasons.push(`momentum ${m.toFixed(2)} → SELL @ ${conviction.toFixed(0)}`);
  } else {
    direction = "ABSTAIN";
    conviction = 0;
    reasons.push(`momentum ${m.toFixed(2)} too weak — abstain`);
  }
  return {
    agentId: "MOMO", agentName: "Momentum Agent", category: "DIRECTION",
    direction, conviction, reasons, observedAt: snap.now.toISOString(),
  };
}
