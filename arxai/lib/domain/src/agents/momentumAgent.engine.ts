import { buildVote, type AgentContext, type AgentVote } from "./agents.types";

// Momentum derived from signal confidence + structural confirmations
// (BoS, opposite-side sweep). Momentum reads decay quickly, so the
// expiration is short.
const EXPIRATION_SEC = 120;

export function momentumAgent(ctx: AgentContext): AgentVote {
  const dir = ctx.signal.direction;
  const conf = ctx.signal.confidence;
  const bos = ctx.structure.recentBreakOfStructure;
  const sweep = ctx.structure.recentLiquiditySweep;
  const evidence: string[] = [`signal confidence ${conf}`];
  const blockers: string[] = [];

  if (!dir) {
    return buildVote({ vote: "WAIT", confidence: 30,
      evidence: [...evidence, "no signal direction"],
      expirationSeconds: EXPIRATION_SEC });
  }

  let score = conf;
  if (bos) { score += 5; evidence.push("recent break of structure confirms momentum"); }

  if (sweep) {
    const opposite = (dir === "BUY"  && sweep.side === "SELL_SIDE")
                  || (dir === "SELL" && sweep.side === "BUY_SIDE");
    if (opposite && sweep.ageBars <= 3) {
      score += 8;
      evidence.push(`fresh opposite-side sweep ${sweep.ageBars} bars ago`);
    } else if (!opposite) {
      score -= 12;
      evidence.push("same-side liquidity already taken — momentum likely exhausted");
    }
  }

  score = Math.max(0, Math.min(100, score));
  if (score < 35) {
    blockers.push(`momentum read ${score} below floor 35`);
    return buildVote({ vote: "BLOCK", confidence: 100 - score,
      evidence, blockers, expirationSeconds: EXPIRATION_SEC });
  }
  if (score < 55) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  return buildVote({ vote: dir, confidence: score, evidence,
    expirationSeconds: EXPIRATION_SEC });
}
