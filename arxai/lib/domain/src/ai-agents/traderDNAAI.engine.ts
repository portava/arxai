import type { AgentVote, AiAgentContext } from "./aiAgents.types";

// traderDnaAI represents the behavioral / human constraint. Critical trader
// state vetoes execution permission — AI cannot override the human's state.
export function traderDnaAI(ctx: AiAgentContext): AgentVote {
  const { revenge, overtrade, patterns } = ctx.trader;
  const reasons: string[] = [];
  let score = 100;

  if (revenge?.detected) {
    if (revenge.severity === "CRITICAL")
      return v("BLOCK", 100, "NEUTRAL", "Revenge trading CRITICAL — execution permission denied",
        { revenge }, true);
    if (revenge.severity === "HIGH")
      return v("BLOCK", 95, "NEUTRAL", "Revenge trading HIGH", { revenge }, true);
    score -= 25; reasons.push(`revenge ${revenge.severity}`);
  }

  if (revenge?.cooldownUntil && new Date(revenge.cooldownUntil).getTime() > (ctx.now ?? new Date()).getTime()) {
    return v("BLOCK", 100, "NEUTRAL", `Trader cooldown active until ${revenge.cooldownUntil}`,
      { cooldown: revenge.cooldownUntil }, true);
  }

  if (overtrade?.detected && overtrade.recommendBlock) {
    return v("BLOCK", 95, "NEUTRAL",
      `Overtrading ${overtrade.severity} (${overtrade.tradesToday} vs baseline ${overtrade.baseline.toFixed(1)})`,
      { overtrade }, true);
  }
  if (overtrade?.detected) { score -= 20; reasons.push(`overtrade ${overtrade.severity}`); }

  for (const hit of patterns.hits) {
    if (hit.severity === "CRITICAL") {
      return v("BLOCK", 95, "NEUTRAL", `Critical pattern ${hit.pattern}`, { pattern: hit }, true);
    }
    if (hit.severity === "HIGH")   { score -= 15; reasons.push(`${hit.pattern} HIGH`); }
    if (hit.severity === "MEDIUM") { score -= 7;  reasons.push(`${hit.pattern} MED`); }
  }

  if (reasons.length === 0) reasons.push("no behavior red flags");
  score = Math.max(0, Math.min(100, score));

  if (score >= 80) return v("EXECUTE", score, "NEUTRAL", reasons.join("; "), { score });
  if (score >= 60) return v("WAIT",    score, "NEUTRAL", reasons.join("; "), { score });
  return v("BLOCK", 100 - score, "NEUTRAL", reasons.join("; "), { score });
}

function v(vote: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>, veto = false): AgentVote {
  return { agent: "traderDnaAI", vote, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: veto };
}
