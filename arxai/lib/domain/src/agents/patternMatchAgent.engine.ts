import { buildVote, signalDirectionAsVote, type AgentContext, type AgentVote } from "./agents.types";

const EXPIRATION_SEC = 300;
const SIMILARITY_FLOOR = 0.6;
const MIN_FOR_VERDICT = 5;
const MIN_FOR_HARD_BLOCK = 10;

// Historical matches are pre-filtered for similarity to the *current*
// signal — they implicitly share the signal's direction. So the agent's
// vote is: echo the signal direction if matches show edge, BLOCK if
// matches show this pattern loses, WAIT if insufficient evidence.
export function patternMatchAgent(ctx: AgentContext): AgentVote {
  const all = ctx.historical.matches;
  const meaningful = all.filter((m) => m.similarityScore >= SIMILARITY_FLOOR);
  const evidence: string[] = [`${meaningful.length} matches above similarity ${SIMILARITY_FLOOR}`];
  const blockers: string[] = [];

  if (meaningful.length < MIN_FOR_VERDICT) {
    return buildVote({ vote: "WAIT", confidence: 40,
      evidence: [...evidence, `need ≥${MIN_FOR_VERDICT} for verdict`],
      expirationSeconds: EXPIRATION_SEC });
  }

  const winRate = meaningful.filter((m) => m.outcomeWasWin).length / meaningful.length;
  const avgR = meaningful.reduce((s, m) => s + m.outcomeR, 0) / meaningful.length;
  evidence.push(`win rate ${(winRate * 100).toFixed(0)}%, avg ${avgR.toFixed(2)}R`);

  if (avgR < 0 && meaningful.length >= MIN_FOR_HARD_BLOCK) {
    blockers.push(`avg ${avgR.toFixed(2)}R over ${meaningful.length} similar setups — pattern loses`);
    return buildVote({ vote: "BLOCK", confidence: 90, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (winRate < 0.35 && meaningful.length >= MIN_FOR_HARD_BLOCK) {
    blockers.push(`win rate ${(winRate * 100).toFixed(0)}% over ${meaningful.length} matches`);
    return buildVote({ vote: "BLOCK", confidence: 85, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  const score = Math.max(0, Math.min(100,
    Math.round((winRate * 60) + (Math.max(0, Math.min(2, avgR)) / 2) * 40),
  ));

  if (score < 45) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  return buildVote({
    vote: signalDirectionAsVote(ctx.signal.direction),
    confidence: score, evidence, expirationSeconds: EXPIRATION_SEC,
  });
}
