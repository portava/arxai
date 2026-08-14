import type { AgentVote, AiAgentContext } from "./aiAgents.types";

export function liquidityAI(ctx: AiAgentContext): AgentVote {
  const liq = (ctx.marketSnapshot.liquidity as { score?: number })?.score ?? 50;
  const dir = ctx.signal.direction;
  const s = ctx.structure;
  const reasons: string[] = [`liquidity score ${liq.toFixed(0)}`];

  // Hard veto — thin market
  if (liq < 25) {
    return v("BLOCK", 95, "NEUTRAL", `Liquidity ${liq.toFixed(0)} <25 — illiquid market`,
      { liq }, true);
  }

  let score = liq;

  // Same-side sweep is bad — liquidity already taken
  if (s.recentLiquiditySweep && dir) {
    const sameSide = (dir === "BUY"  && s.recentLiquiditySweep.side === "BUY_SIDE")
                  || (dir === "SELL" && s.recentLiquiditySweep.side === "SELL_SIDE");
    if (sameSide && s.recentLiquiditySweep.ageBars <= 5) {
      reasons.push("same-side liquidity recently swept");
      return v("BLOCK", 80, dir === "BUY" ? "BEARISH" : "BULLISH",
        reasons.join("; "), { liq, sweep: s.recentLiquiditySweep });
    }
  }

  // Untested OB on our side improves liquidity quality
  if (s.orderBlock && s.orderBlock.side === dir && !s.orderBlock.tested) {
    score += 10; reasons.push("untested OB confluence");
  }
  // FVG present
  if (s.fairValueGap && s.fairValueGap.side === dir) {
    score += 5; reasons.push("favourable FVG");
  }

  score = Math.max(0, Math.min(100, score));
  const bias = dir === "BUY" ? "BULLISH" : dir === "SELL" ? "BEARISH" : "NEUTRAL";

  if (score >= 75) return v("EXECUTE", score, bias, reasons.join("; "), { liq, score });
  if (score >= 55) return v("WAIT",    score, bias, reasons.join("; "), { liq, score });
  return v("BLOCK", 100 - score, bias, reasons.join("; "), { liq, score });
}

function v(vote: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>, veto = false): AgentVote {
  return { agent: "liquidityAI", vote, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: veto };
}
