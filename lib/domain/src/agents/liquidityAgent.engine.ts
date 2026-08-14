import { buildVote, type AgentContext, type AgentVote } from "./agents.types";

// Liquidity changes fast — short expiration.
const EXPIRATION_SEC = 60;
const ILLIQUID_FLOOR = 25;

export function liquidityAgent(ctx: AgentContext): AgentVote {
  const liq = (ctx.marketSnapshot.liquidity as { score?: number })?.score ?? 50;
  const dir = ctx.signal.direction;
  const s = ctx.structure;
  const evidence: string[] = [`liquidity score ${liq.toFixed(0)}`];
  const blockers: string[] = [];

  if (liq < ILLIQUID_FLOOR) {
    blockers.push(`liquidity ${liq.toFixed(0)} < ${ILLIQUID_FLOOR} — illiquid market`);
    return buildVote({ vote: "BLOCK", confidence: 95, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  if (!dir) {
    return buildVote({ vote: "WAIT", confidence: 40,
      evidence: [...evidence, "no signal direction to confirm"],
      expirationSeconds: EXPIRATION_SEC });
  }

  // Same-side liquidity swept — the move that justified our direction may
  // have already happened. Block.
  if (s.recentLiquiditySweep) {
    const sameSide = (dir === "BUY"  && s.recentLiquiditySweep.side === "BUY_SIDE")
                  || (dir === "SELL" && s.recentLiquiditySweep.side === "SELL_SIDE");
    if (sameSide && s.recentLiquiditySweep.ageBars <= 5) {
      blockers.push(`same-side sweep ${s.recentLiquiditySweep.ageBars} bars ago — liquidity already taken`);
      return buildVote({ vote: "BLOCK", confidence: 80, evidence, blockers,
        expirationSeconds: EXPIRATION_SEC });
    }
  }

  let score = liq;
  if (s.orderBlock && s.orderBlock.side === dir && !s.orderBlock.tested) {
    score += 10; evidence.push("untested order-block confluence");
  }
  if (s.fairValueGap && s.fairValueGap.side === dir) {
    score += 5; evidence.push("favourable fair-value gap");
  }
  score = Math.max(0, Math.min(100, score));

  if (score < 50) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  return buildVote({ vote: dir, confidence: score, evidence,
    expirationSeconds: EXPIRATION_SEC });
}
