import type { AgentVote, AiAgentContext } from "./aiAgents.types";

// macroAI: macro environment proxy. Without a real news/calendar feed, uses
// regime + volatility + session as the macro picture; flips conservative
// when those signals look unstable.
export function macroAI(ctx: AiAgentContext): AgentVote {
  const regime = ctx.marketSnapshot.regime?.regime ?? "UNKNOWN";
  const vol = ctx.volatility;
  const reasons: string[] = [`regime ${regime}`];
  let score = 60;

  if (regime === "TRENDING_UP" || regime === "TRENDING_DOWN") {
    score += 20; reasons.push("trending macro favourable");
  } else if (regime === "BREAKOUT") {
    score -= 5;  reasons.push("breakout — wider regime risk");
  } else if (regime === "RANGE") {
    score += 5;  reasons.push("range — neutral macro");
  } else if (regime === "CHOP") {
    score -= 10; reasons.push("chop — risk of false breakouts");
  } else {
    score -= 25; reasons.push("regime unknown");
  }

  if (vol.atrPercentile > 90) {
    return vote("BLOCK", 90, "NEUTRAL",
      `Macro caution: ATR p${vol.atrPercentile.toFixed(0)} suggests stress conditions`,
      { regime, atrPercentile: vol.atrPercentile });
  }
  if (vol.atrPercentile > 75) { score -= 15; reasons.push("ATR p>75 — risk-off conditions"); }

  // Session edges suggest macro illiquidity around news / open / close
  if (ctx.session.minutesSinceSessionOpen < 10 || ctx.session.minutesUntilSessionEnd < 15) {
    score -= 10; reasons.push("session edge — macro illiquidity risk");
  }

  score = Math.max(0, Math.min(100, score));
  if (score >= 75) return vote("EXECUTE", score, "NEUTRAL", reasons.join("; "), { regime, vol });
  if (score >= 50) return vote("WAIT",    score, "NEUTRAL", reasons.join("; "), { regime, vol });
  return vote("BLOCK", 100 - score, "NEUTRAL", reasons.join("; "), { regime, vol });
}

function vote(v: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>): AgentVote {
  return { agent: "macroAI", vote: v, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: false };
}
