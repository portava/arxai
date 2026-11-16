import {
  type AgentScorecard, type AgentVerdictScore, type ClosedTradeRecord,
  type TradeDirection, RETROSPECTIVE_THRESHOLDS,
} from "./retrospective.types";

// scoreAgents — answers BOTH Q3 (which agent was right) and Q4 (which was
// wrong) in one pass to keep the right/wrong partitions mutually consistent
// (an agent appears in exactly one bucket per trade).
//
// The "winning direction" is derived from the realized outcome, NOT from
// the trade's own direction:
//   • If pnlR > +ambiguousPnlR → winning direction == trade direction
//   • If pnlR < −ambiguousPnlR → winning direction == OPPOSITE of trade direction
//   • Otherwise → AMBIGUOUS (no agent gets credit or blame for a near-zero outcome)
//
// alignmentScore (0..100) blends direction-correctness with confidence:
//   • Right + high confidence  → high score
//   • Right + low confidence   → moderate score (correct but not committed)
//   • Wrong + high confidence  → 0 (full blame)
//   • Wrong + low confidence   → low non-zero (wrong but they hedged)
//   • Abstained                → null bucket; not scored either way
export function scoreAgents(rec: ClosedTradeRecord): AgentScorecard {
  const T = RETROSPECTIVE_THRESHOLDS.agents;
  const reasons: string[] = [];

  // ── Determine winning direction ────────────────────────────────────────
  let winningDirection: TradeDirection | "AMBIGUOUS";
  if (rec.outcome.pnlR > T.ambiguousPnlR) {
    winningDirection = rec.outcome.direction;
  } else if (rec.outcome.pnlR < -T.ambiguousPnlR) {
    winningDirection = oppositeDirection(rec.outcome.direction);
  } else {
    winningDirection = "AMBIGUOUS";
  }
  reasons.push(`winning direction: ${winningDirection} (pnl ${rec.outcome.pnlR.toFixed(2)}R)`);

  if (winningDirection === "AMBIGUOUS") {
    // No scoring possible — return everyone as abstained-equivalent with
    // an explicit reason. consensusWasCorrect is null.
    const allAsNeutral: AgentVerdictScore[] = rec.consensus.agentVerdicts.map((v) => ({
      agentId: v.agentId,
      agentName: v.agentName,
      agentDirection: v.agentDirection,
      agentConfidence: v.agentConfidence,
      alignmentScore: 50,
      contribution: "NEUTRAL",
      reasons: ["outcome too small to assign blame or credit"],
    }));
    return {
      winningDirection,
      rightAgents: [], wrongAgents: [], abstainedAgents: allAsNeutral,
      consensusWasCorrect: null,
      reasons,
    };
  }

  const rightAgents: AgentVerdictScore[]     = [];
  const wrongAgents: AgentVerdictScore[]     = [];
  const abstainedAgents: AgentVerdictScore[] = [];

  for (const v of rec.consensus.agentVerdicts) {
    // Below-threshold confidence is treated as effective abstention.
    if (v.agentDirection === "ABSTAIN" || v.agentConfidence < T.minConfidenceToCount) {
      abstainedAgents.push({
        agentId: v.agentId,
        agentName: v.agentName,
        agentDirection: v.agentDirection,
        agentConfidence: v.agentConfidence,
        alignmentScore: 50,
        contribution: "NEUTRAL",
        reasons: v.agentDirection === "ABSTAIN"
          ? ["abstained — neither credit nor blame"]
          : [`confidence ${v.agentConfidence} below scoring floor ${T.minConfidenceToCount}`],
      });
      continue;
    }

    const isRight = v.agentDirection === winningDirection;
    if (isRight) {
      // Score: 50 + (confidence/100)*50 → high conf right = up to 100
      const alignmentScore = 50 + (v.agentConfidence / 100) * 50;
      rightAgents.push({
        agentId: v.agentId, agentName: v.agentName,
        agentDirection: v.agentDirection, agentConfidence: v.agentConfidence,
        alignmentScore,
        contribution: "HELPFUL",
        reasons: [`called ${v.agentDirection} with ${v.agentConfidence}% conviction — matched outcome`],
      });
    } else {
      // Score: max(0, 50 − (confidence/100)*50) → high conf wrong = 0
      const alignmentScore = Math.max(0, 50 - (v.agentConfidence / 100) * 50);
      wrongAgents.push({
        agentId: v.agentId, agentName: v.agentName,
        agentDirection: v.agentDirection, agentConfidence: v.agentConfidence,
        alignmentScore,
        contribution: "HARMFUL",
        reasons: [`called ${v.agentDirection} with ${v.agentConfidence}% conviction — outcome went ${winningDirection}`],
      });
    }
  }

  // Order each bucket so the most-confident appears first — that's what
  // matters for credit/blame attribution.
  rightAgents.sort((a, b) => b.agentConfidence - a.agentConfidence);
  wrongAgents.sort((a, b) => b.agentConfidence - a.agentConfidence);

  const consensusWasCorrect = rec.consensus.consensusDirection === winningDirection;
  reasons.push(
    `consensus said ${rec.consensus.consensusDirection} @ ${rec.consensus.consensusConfidence}% — ${consensusWasCorrect ? "correct" : "wrong"}`,
  );
  if (rightAgents.length > 0) reasons.push(`${rightAgents.length} right agent(s), top: ${rightAgents[0].agentName}`);
  if (wrongAgents.length > 0) reasons.push(`${wrongAgents.length} wrong agent(s), most-confident: ${wrongAgents[0].agentName}`);

  return {
    winningDirection,
    rightAgents, wrongAgents, abstainedAgents,
    consensusWasCorrect,
    reasons,
  };
}

function oppositeDirection(d: TradeDirection): TradeDirection {
  return d === "BUY" ? "SELL" : "BUY";
}
