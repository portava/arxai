import { buildVote, signalDirectionAsVote, type AgentContext, type AgentVote } from "./agents.types";

// Behavioral state changes slowly — moderate expiration. Trader-DNA blocks
// expire shorter so a cooldown that just elapsed is reconsidered promptly.
const EXPIRATION_SEC_OK    = 300;
const EXPIRATION_SEC_BLOCK = 60;

export function traderDnaAgent(ctx: AgentContext): AgentVote {
  const { revenge, overtrade, patterns } = ctx.trader;
  const evidence: string[] = [];
  const blockers: string[] = [];
  let score = 100;

  if (revenge?.detected) {
    if (revenge.severity === "CRITICAL" || revenge.severity === "HIGH") {
      blockers.push(`revenge trading ${revenge.severity}`);
    } else { score -= 25; evidence.push(`revenge ${revenge.severity}`); }
  }

  if (revenge?.cooldownUntil) {
    const cd = new Date(revenge.cooldownUntil).getTime();
    const nowMs = (ctx.now ?? new Date()).getTime();
    if (cd > nowMs) {
      blockers.push(`trader cooldown active until ${revenge.cooldownUntil}`);
    }
  }

  if (overtrade?.detected) {
    if (overtrade.recommendBlock) {
      blockers.push(`overtrading ${overtrade.severity} (${overtrade.tradesToday} vs baseline ${overtrade.baseline.toFixed(1)})`);
    } else {
      score -= 20; evidence.push(`overtrade ${overtrade.severity}`);
    }
  }

  for (const hit of patterns.hits) {
    if (hit.severity === "CRITICAL")    blockers.push(`critical pattern ${hit.pattern}`);
    else if (hit.severity === "HIGH")   { score -= 15; evidence.push(`${hit.pattern} HIGH`); }
    else if (hit.severity === "MEDIUM") { score -= 7;  evidence.push(`${hit.pattern} MED`); }
  }

  if (blockers.length > 0) {
    return buildVote({ vote: "BLOCK", confidence: 95, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC_BLOCK });
  }
  if (evidence.length === 0) evidence.push("no behavior red flags");
  score = Math.max(0, Math.min(100, score));

  if (score < 60) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC_OK });
  }
  return buildVote({
    vote: signalDirectionAsVote(ctx.signal.direction),
    confidence: score, evidence, expirationSeconds: EXPIRATION_SEC_OK,
  });
}
