import type { AgentSystemSnapshot, QualityVerdict } from "../agentSystem.types";

// Entry Precision Agent — quality score from EMA confluence + proximity to swing.
export function entryPrecisionAgent(snap: AgentSystemSnapshot): QualityVerdict {
  const reasons: string[] = [];
  let score = 50;

  const conf = snap.market.emaConfluence01;
  const confBoost = conf * 30;
  score += confBoost;
  reasons.push(`+${confBoost.toFixed(0)} from EMA confluence ${conf.toFixed(2)}`);

  const px = snap.market.pipsToNearestSwing;
  if (px <= 3)       { score += 20; reasons.push(`+20 — entry within 3p of swing reference`); }
  else if (px <= 10) { score += 10; reasons.push(`+10 — entry within 10p of swing reference`); }
  else if (px > 30)  { score -= 15; reasons.push(`-15 — entry ${px.toFixed(0)}p from nearest swing (loose)`); }

  score = Math.max(0, Math.min(100, score));
  return {
    agentId: "PRECISION", agentName: "Entry Precision Agent", category: "QUALITY",
    qualityScore: score, reasons, observedAt: snap.now.toISOString(),
  };
}
