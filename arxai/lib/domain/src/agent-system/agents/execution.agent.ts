import {
  type AgentSystemSnapshot, type HardBlockVerdict,
  AGENT_SYSTEM_THRESHOLDS,
} from "../agentSystem.types";

// Execution Agent — analyzes broker/market execution feasibility ONLY.
export function executionAgent(snap: AgentSystemSnapshot): HardBlockVerdict {
  const T = AGENT_SYSTEM_THRESHOLDS.execution;
  const reasons: string[] = [];
  const m = snap.market;
  const e = snap.execution;
  const p = snap.policy;
  let vetoReason: string | null = null;

  if (!e.brokerConnected) {
    vetoReason = "broker not connected";
  } else if (!m.marketOpen) {
    vetoReason = "market closed";
  } else if (m.liquidityScore01 < p.minLiquidity01) {
    vetoReason = `liquidity ${m.liquidityScore01.toFixed(2)} < policy floor ${p.minLiquidity01}`;
  } else if (m.spreadPips >= T.spreadProhibitivePips) {
    vetoReason = `spread ${m.spreadPips.toFixed(1)}p ≥ execution-prohibitive ${T.spreadProhibitivePips}p`;
  } else if (m.spreadPips > p.maxSpreadPipsPolicy) {
    vetoReason = `spread ${m.spreadPips.toFixed(1)}p > policy ${p.maxSpreadPipsPolicy.toFixed(1)}p`;
  }

  reasons.push(vetoReason
    ? `VETO: ${vetoReason}`
    : `execution channel OK (spread ${m.spreadPips.toFixed(1)}p, liquidity ${m.liquidityScore01.toFixed(2)})`);

  return {
    agentId: "EXEC", agentName: "Execution Agent", category: "HARD_BLOCK",
    vetoed: vetoReason !== null, vetoReason, reasons,
    observedAt: snap.now.toISOString(),
  };
}
