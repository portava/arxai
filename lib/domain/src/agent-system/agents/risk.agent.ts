import type { AgentSystemSnapshot, HardBlockVerdict } from "../agentSystem.types";

// Risk Agent — analyzes account-level risk envelope ONLY.
// Cannot place trades; only emits a hard-block verdict.
export function riskAgent(snap: AgentSystemSnapshot): HardBlockVerdict {
  const reasons: string[] = [];
  const a = snap.account;
  const p = snap.policy;
  let vetoReason: string | null = null;

  if (a.drawdownPct >= p.maxDrawdownPct) {
    vetoReason = `drawdown ${a.drawdownPct.toFixed(2)}% ≥ policy ceiling ${p.maxDrawdownPct.toFixed(2)}%`;
  } else if (a.openTradesCount >= p.maxConcurrentTrades) {
    vetoReason = `${a.openTradesCount} open trades at concurrency ceiling ${p.maxConcurrentTrades}`;
  } else if (a.dailyPnLPct <= p.dailyLossLimitPct) {
    vetoReason = `daily PnL ${a.dailyPnLPct.toFixed(2)}% past daily loss limit ${p.dailyLossLimitPct.toFixed(2)}%`;
  } else if (snap.setup.proposedRiskPct > p.maxSingleTradeRiskPct) {
    vetoReason = `proposed risk ${snap.setup.proposedRiskPct.toFixed(2)}% > per-trade ceiling ${p.maxSingleTradeRiskPct.toFixed(2)}%`;
  }

  reasons.push(vetoReason
    ? `VETO: ${vetoReason}`
    : `risk envelope OK (dd ${a.drawdownPct.toFixed(2)}%, open ${a.openTradesCount}/${p.maxConcurrentTrades})`);

  return {
    agentId: "RISK", agentName: "Risk Agent", category: "HARD_BLOCK",
    vetoed: vetoReason !== null, vetoReason, reasons,
    observedAt: snap.now.toISOString(),
  };
}
