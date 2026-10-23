import type { AgentVote, AiAgentContext } from "./aiAgents.types";

export function sessionAI(ctx: AiAgentContext): AgentVote {
  const s = ctx.session;
  const reasons: string[] = [`current ${s.current}`];

  if (s.current === "OFF_HOURS") {
    return vote("BLOCK", 90, "NEUTRAL",
      "OFF_HOURS — illiquid, avoid execution", { session: s.current }, true);
  }
  if (s.minutesUntilSessionEnd < 10) {
    return vote("BLOCK", 80, "NEUTRAL",
      `Session closing in ${s.minutesUntilSessionEnd}m — insufficient time`, { s });
  }

  let score: number;
  if (s.preferredForStrategy.includes(s.current)) {
    score = 85;
    reasons.push("matches strategy preferred session");
  } else if (s.preferredForStrategy.length === 0) {
    score = 60; reasons.push("strategy has no session preference");
  } else {
    score = 35; reasons.push(`strategy prefers ${s.preferredForStrategy.join("/")}`);
  }

  if (s.minutesSinceSessionOpen < 15) { score -= 15; reasons.push("session just opened"); }
  if (s.minutesUntilSessionEnd < 30)  { score -= 10; reasons.push("session closing soon"); }

  score = Math.max(0, Math.min(100, score));
  if (score >= 70) return vote("EXECUTE", score, "NEUTRAL", reasons.join("; "), { s });
  if (score >= 45) return vote("WAIT",    score, "NEUTRAL", reasons.join("; "), { s });
  return vote("BLOCK", 100 - score, "NEUTRAL", reasons.join("; "), { s });
}

function vote(v: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>, veto = false): AgentVote {
  return { agent: "sessionAI", vote: v, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: veto };
}
