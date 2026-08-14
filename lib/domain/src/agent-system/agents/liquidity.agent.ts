import type { AgentSystemSnapshot, DirectionVerdict } from "../agentSystem.types";

// Liquidity Agent — votes from where unswept liquidity sits.
// Sweep-continuation framing: liquidity ABOVE current price is a magnet,
// price tends to seek it → vote BUY. Symmetric for SELL. No clear pool → abstain.
export function liquidityAgent(snap: AgentSystemSnapshot): DirectionVerdict {
  const reasons: string[] = [];
  const side = snap.market.unsweptLiquiditySide;
  if (side === null) {
    reasons.push("no clear unswept liquidity pool — abstain");
    return {
      agentId: "LIQ", agentName: "Liquidity Agent", category: "DIRECTION",
      direction: "ABSTAIN", conviction: 0, reasons, observedAt: snap.now.toISOString(),
    };
  }
  reasons.push(`unswept liquidity to the ${side} side → vote ${side} @ 60 (sweep continuation)`);
  return {
    agentId: "LIQ", agentName: "Liquidity Agent", category: "DIRECTION",
    direction: side, conviction: 60, reasons, observedAt: snap.now.toISOString(),
  };
}
