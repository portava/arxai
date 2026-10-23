import { buildVote, signalDirectionAsVote, type AgentContext, type AgentVote } from "./agents.types";

// Vol regime moves slowly — moderate expiration.
const EXPIRATION_SEC = 300;

export function volatilityAgent(ctx: AgentContext): AgentVote {
  const v = ctx.volatility;
  const evidence: string[] = [`vol ${v.current.toFixed(0)} (sweet ${v.sweetSpotLow}-${v.sweetSpotHigh})`,
                              `ATR p${v.atrPercentile.toFixed(0)}`];
  const blockers: string[] = [];

  if (v.atrPercentile > 95) {
    blockers.push(`ATR p${v.atrPercentile.toFixed(0)} — extreme volatility, gap/slippage risk`);
    return buildVote({ vote: "BLOCK", confidence: 95, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (v.atrPercentile < 8) {
    blockers.push(`ATR p${v.atrPercentile.toFixed(0)} — too quiet, insufficient range`);
    return buildVote({ vote: "BLOCK", confidence: 75, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  let score: number;
  if (v.current >= v.sweetSpotLow && v.current <= v.sweetSpotHigh) {
    score = 90; evidence.push("inside sweet-spot band");
  } else {
    const drift = v.current < v.sweetSpotLow
      ? (v.sweetSpotLow - v.current) / Math.max(1, v.sweetSpotLow)
      : (v.current - v.sweetSpotHigh) / Math.max(1, 100 - v.sweetSpotHigh);
    score = Math.max(20, Math.round(90 * (1 - drift)));
    evidence.push(`outside sweet-spot (drift ${(drift * 100).toFixed(0)}%)`);
  }
  if (v.atrPercentile > 85) { score -= 15; evidence.push("ATR p>85 — elevated"); }
  score = Math.max(0, Math.min(100, score));

  if (score < 50) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  return buildVote({
    vote: signalDirectionAsVote(ctx.signal.direction),
    confidence: score, evidence,
    expirationSeconds: EXPIRATION_SEC,
  });
}
