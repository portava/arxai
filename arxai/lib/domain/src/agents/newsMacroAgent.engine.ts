import { buildVote, type AgentContext, type AgentVote } from "./agents.types";

// Macro environment moves slowly — long expiration. The news/macro agent
// derives direction from the regime: TRENDING_UP → BUY, TRENDING_DOWN →
// SELL, RANGE → WAIT, BREAKOUT → echo signal direction (breakouts can go
// either way), CHOP → BLOCK.
const EXPIRATION_SEC = 600;

export function newsMacroAgent(ctx: AgentContext): AgentVote {
  const regime = ctx.marketSnapshot.regime?.regime ?? "UNKNOWN";
  const vol = ctx.volatility;
  const evidence: string[] = [`regime ${regime}`, `ATR p${vol.atrPercentile.toFixed(0)}`];
  const blockers: string[] = [];

  // Macro stress conditions
  if (vol.atrPercentile > 90) {
    blockers.push(`ATR p${vol.atrPercentile.toFixed(0)} — macro stress / risk-off`);
    return buildVote({ vote: "BLOCK", confidence: 90, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (regime === "UNKNOWN") {
    blockers.push("regime unknown — insufficient macro context");
    return buildVote({ vote: "BLOCK", confidence: 70, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (regime === "CHOP") {
    blockers.push("chop regime — macro favours staying flat");
    return buildVote({ vote: "BLOCK", confidence: 75, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  let confidence = 70;
  if (vol.atrPercentile > 75) { confidence -= 15; evidence.push("ATR p>75 — risk-off conditions"); }
  if (ctx.session.minutesSinceSessionOpen < 10 || ctx.session.minutesUntilSessionEnd < 15) {
    confidence -= 10; evidence.push("session edge — macro illiquidity risk");
  }
  confidence = Math.max(0, Math.min(100, confidence));

  if (regime === "TRENDING_UP") {
    return buildVote({ vote: "BUY",  confidence: confidence + 10, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (regime === "TRENDING_DOWN") {
    return buildVote({ vote: "SELL", confidence: confidence + 10, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (regime === "RANGE") {
    return buildVote({ vote: "WAIT", confidence: confidence,
      evidence: [...evidence, "range — no macro directional edge"],
      expirationSeconds: EXPIRATION_SEC });
  }
  // BREAKOUT — echo the signal direction
  if (ctx.signal.direction === "BUY")  return buildVote({ vote: "BUY",  confidence, evidence: [...evidence, "breakout — echoing signal"], expirationSeconds: EXPIRATION_SEC });
  if (ctx.signal.direction === "SELL") return buildVote({ vote: "SELL", confidence, evidence: [...evidence, "breakout — echoing signal"], expirationSeconds: EXPIRATION_SEC });
  return buildVote({ vote: "WAIT", confidence, evidence, expirationSeconds: EXPIRATION_SEC });
}
