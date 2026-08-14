import type {
  AgentAuditEntry, SelfAuditInput, SelfAuditResult,
} from "./aiAgents.types";

// "Every trade must self-audit after closure."
// Rates each agent's prediction accuracy + calibration error against the
// realised outcome so future weight tuning can be data-driven.
export function selfAudit(input: SelfAuditInput): SelfAuditResult {
  const { consensus, outcomeWasWin, outcomeR } = input;

  const consensusCorrect =
    (consensus.consensusVote === "EXECUTE" && outcomeWasWin) ||
    (consensus.consensusVote === "BLOCK" && !outcomeWasWin) ||
    (consensus.consensusVote === "WAIT");   // WAIT is never wrong on outcome alone

  const perAgent: AgentAuditEntry[] = consensus.votes.map((v) => {
    const predictionAccurate =
      (v.vote === "EXECUTE" && outcomeWasWin) ||
      (v.vote === "BLOCK" && !outcomeWasWin) ||
      (v.vote === "WAIT");   // mirror the consensus rule
    // Calibration error: distance between confidence-as-probability and the actual outcome
    const probability = v.confidence / 100;
    const actualBinary = predictionAccurate ? 1 : 0;
    const calibrationError = Math.abs(probability - actualBinary);
    return {
      agent: v.agent,
      vote: v.vote,
      confidence: v.confidence,
      weight: consensus.weights[v.agent],
      predictionAccurate,
      calibrationError,
    };
  });

  const averageCalibrationError = perAgent.reduce((s, e) => s + e.calibrationError, 0) / Math.max(1, perAgent.length);

  const lessons = buildLessons(consensus, perAgent, outcomeR, consensusCorrect);

  return {
    consensusCorrect,
    outcomeR,
    perAgent,
    averageCalibrationError,
    lessons,
    closedAt: input.closedAt,
  };
}

function buildLessons(
  consensus: SelfAuditInput["consensus"],
  entries: AgentAuditEntry[],
  outcomeR: number,
  consensusCorrect: boolean,
): string[] {
  const out: string[] = [];

  // Headline
  out.push(`Consensus ${consensus.consensusVote} on ${consensus.signalId} → outcome ${outcomeR.toFixed(2)}R (${consensusCorrect ? "correct" : "incorrect"})`);

  // Worst-calibrated agents
  const sorted = [...entries].sort((a, b) => b.calibrationError - a.calibrationError);
  const worst = sorted.slice(0, 3).filter((e) => e.calibrationError > 0.4);
  if (worst.length > 0) {
    out.push(`Most miscalibrated: ${worst.map((e) => `${e.agent} (err ${e.calibrationError.toFixed(2)})`).join(", ")}`);
  }

  // Disagreement signal: agents that voted opposite to outcome at high confidence
  const overconfidentWrong = entries.filter(
    (e) => !e.predictionAccurate && e.confidence >= 80,
  );
  if (overconfidentWrong.length > 0) {
    out.push(`Overconfident wrong votes: ${overconfidentWrong.map((e) => e.agent).join(", ")} — consider lowering their weights for this regime`);
  }

  // High-confidence right
  const confidentRight = entries.filter((e) => e.predictionAccurate && e.confidence >= 80 && e.vote !== "WAIT");
  if (confidentRight.length > 0) {
    out.push(`Confident right: ${confidentRight.map((e) => e.agent).join(", ")} — candidates for weight increase`);
  }

  if (out.length === 1) out.push("No notable calibration outliers");
  return out;
}
