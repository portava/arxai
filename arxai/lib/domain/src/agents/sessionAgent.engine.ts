import { buildVote, signalDirectionAsVote, type AgentContext, type AgentVote } from "./agents.types";

// Session vote expires when the session ends — caller-determined via the
// minutesUntilSessionEnd context field.
export function sessionAgent(ctx: AgentContext): AgentVote {
  const s = ctx.session;
  const evidence: string[] = [`session ${s.current}`,
                              `${s.minutesSinceSessionOpen}m since open / ${s.minutesUntilSessionEnd}m until close`];
  const blockers: string[] = [];
  // Vote expires no later than session close (clamped to 1h max).
  const expirationSeconds = Math.max(60, Math.min(3600, s.minutesUntilSessionEnd * 60));

  if (s.current === "OFF_HOURS") {
    blockers.push("OFF_HOURS — illiquid session window");
    return buildVote({ vote: "BLOCK", confidence: 90, evidence, blockers, expirationSeconds });
  }
  if (s.minutesUntilSessionEnd < 10) {
    blockers.push(`session closing in ${s.minutesUntilSessionEnd}m — insufficient time`);
    return buildVote({ vote: "BLOCK", confidence: 85, evidence, blockers,
      expirationSeconds: Math.max(30, s.minutesUntilSessionEnd * 60) });
  }

  let score: number;
  if (s.preferredForStrategy.includes(s.current)) {
    score = 85; evidence.push(`matches preferred session for strategy`);
  } else if (s.preferredForStrategy.length === 0) {
    score = 60; evidence.push("strategy has no session preference");
  } else {
    score = 35; evidence.push(`strategy prefers ${s.preferredForStrategy.join("/")}`);
  }
  if (s.minutesSinceSessionOpen < 15) { score -= 15; evidence.push("session just opened"); }
  if (s.minutesUntilSessionEnd < 30)  { score -= 10; evidence.push("session closing soon"); }
  score = Math.max(0, Math.min(100, score));

  if (score < 45) {
    return buildVote({ vote: "WAIT", confidence: score, evidence, expirationSeconds });
  }
  return buildVote({
    vote: signalDirectionAsVote(ctx.signal.direction),
    confidence: score, evidence, expirationSeconds,
  });
}
