import type { AgentSystemSnapshot, DirectionVerdict } from "../agentSystem.types";

// Trend Agent — votes from longer-frame trend bias ONLY.
export function trendAgent(snap: AgentSystemSnapshot): DirectionVerdict {
  const reasons: string[] = [];
  const bias = snap.market.trendBiasSigned;
  let direction: DirectionVerdict["direction"];
  let conviction: number;

  if (bias >= 0.2) {
    direction = "BUY";
    conviction = clamp(bias * 100, 30, 100);
    reasons.push(`trend bias +${bias.toFixed(2)} → BUY @ ${conviction.toFixed(0)}`);
  } else if (bias <= -0.2) {
    direction = "SELL";
    conviction = clamp(Math.abs(bias) * 100, 30, 100);
    reasons.push(`trend bias ${bias.toFixed(2)} → SELL @ ${conviction.toFixed(0)}`);
  } else {
    direction = "ABSTAIN";
    conviction = 0;
    reasons.push(`trend bias ${bias.toFixed(2)} too flat — abstain`);
  }
  return {
    agentId: "TREND", agentName: "Trend Agent", category: "DIRECTION",
    direction, conviction, reasons, observedAt: snap.now.toISOString(),
  };
}
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
