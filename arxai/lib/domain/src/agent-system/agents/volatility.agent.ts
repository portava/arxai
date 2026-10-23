import type { AgentSystemSnapshot, QualityVerdict } from "../agentSystem.types";

// Volatility Agent — quality score from volatility regime.
// Mid-range = high quality (predictable). Extremes (too quiet OR too chaotic)
// = low quality. Fail-safe to neutral 50 when baseline missing.
export function volatilityAgent(snap: AgentSystemSnapshot): QualityVerdict {
  const reasons: string[] = [];
  const v = snap.market.volatilityNow;
  const h = snap.policy.volHistorical;
  let qualityScore: number;

  if (h === null || h.median <= 0 || h.p10 <= 0 || h.p90 <= 0) {
    qualityScore = 50;
    reasons.push("volatility baseline not recorded — neutral 50");
  } else if (v < h.p10) {
    qualityScore = 30;
    reasons.push(`vol ${v.toFixed(4)} < P10 ${h.p10.toFixed(4)} — too quiet, score 30`);
  } else if (v > h.p90) {
    qualityScore = 25;
    reasons.push(`vol ${v.toFixed(4)} > P90 ${h.p90.toFixed(4)} — too chaotic, score 25`);
  } else {
    const dist = Math.abs(v - h.median) / Math.max(h.p90 - h.p10, 1e-9);
    qualityScore = Math.max(80, Math.min(95, 95 - dist * 15));
    reasons.push(`vol ${v.toFixed(4)} mid-range (median ${h.median.toFixed(4)}) — quality ${qualityScore.toFixed(0)}`);
  }

  return {
    agentId: "VOL", agentName: "Volatility Agent", category: "QUALITY",
    qualityScore, reasons, observedAt: snap.now.toISOString(),
  };
}
