import type {
  AgentRuling, CourtSession, ReplayableContributor, ReplayableDecision,
  ReplayableOutcome, Stance, VerdictGrade,
} from "./tradeCourt.types";

// replayTrade — walk the decision chain in order, grade each contributor
// against the realized outcome, return a CourtSession.
//
// Grading rules:
//   • |pnlR| ≤ 0.20 → outcome ambiguous: every contributor ABSTAINED
//     (matches the project-wide ambiguous-outcome rule)
//   • APPROVED contributors: RIGHT if pnl > 0, WRONG if pnl < 0
//   • BLOCKED  contributors: RIGHT if pnl < 0, WRONG if pnl > 0
//                            (only meaningful when the trade EXECUTED
//                             despite the block — i.e. governor overrode
//                             a vetoing contributor, or this is a shadow)
//   • WARNED   contributors: NEUTRAL on win, half-credit RIGHT on loss
//   • ABSTAINED / NEUTRAL stance: ABSTAINED grade
//
// scoreDelta is the contributor's signed contribution to the netGradeScore
// — RIGHT contributes its conviction, WRONG contributes -conviction.
export function replayTrade(
  decision: ReplayableDecision,
  outcome: ReplayableOutcome,
): CourtSession {
  const reasons: string[] = [];
  const ambiguous = Math.abs(outcome.pnlR) <= 0.20;
  const won = outcome.pnlR > 0.20;
  const lost = outcome.pnlR < -0.20;

  const rulings: AgentRuling[] = decision.contributors.map((c) => gradeContributor(c, ambiguous, won, lost));
  const netGradeScore = rulings.reduce((sum, r) => sum + r.scoreDelta, 0);

  reasons.push(`replayed ${rulings.length} contributor(s); net grade ${netGradeScore.toFixed(0)} on ${outcome.pnlR.toFixed(2)}R`);
  if (ambiguous) reasons.push(`ambiguous outcome (|${outcome.pnlR.toFixed(2)}R| ≤ 0.20) — all contributors abstained from grading`);

  return {
    decisionId: decision.decisionId,
    outcome,
    rulings,
    netGradeScore,
    reasons,
  };
}

function gradeContributor(
  c: ReplayableContributor,
  ambiguous: boolean, won: boolean, lost: boolean,
): AgentRuling {
  const reasons: string[] = [];
  let grade: VerdictGrade = "NEUTRAL";
  let scoreDelta = 0;

  if (ambiguous) {
    grade = "ABSTAINED";
    reasons.push("outcome too small to grade");
  } else {
    grade = scoreStance(c.stance, won, lost, c.conviction, reasons);
    if (grade === "RIGHT")  scoreDelta = +c.conviction;
    if (grade === "WRONG")  scoreDelta = -c.conviction;
  }

  return {
    contributorId: c.contributorId, contributorName: c.contributorName, role: c.role,
    stance: c.stance, grade, scoreDelta, reasons,
  };
}

function scoreStance(
  stance: Stance, won: boolean, lost: boolean, conviction: number, reasons: string[],
): VerdictGrade {
  switch (stance) {
    case "APPROVED":
      reasons.push(won ? `approved + win = RIGHT` : lost ? `approved + loss = WRONG` : "approved + tie");
      return won ? "RIGHT" : lost ? "WRONG" : "NEUTRAL";
    case "BLOCKED":
      reasons.push(lost ? `blocked + loss happened anyway = RIGHT (block was overridden)` : won ? `blocked + win happened anyway = WRONG` : "blocked + tie");
      return lost ? "RIGHT" : won ? "WRONG" : "NEUTRAL";
    case "WARNED":
      reasons.push(lost ? `warned + loss = RIGHT (half-credit)` : `warned + win = NEUTRAL`);
      return lost ? "RIGHT" : "NEUTRAL";
    case "ABSTAINED":
    case "NEUTRAL":
    default:
      reasons.push(`${stance.toLowerCase()} stance — no grade`);
      return "ABSTAINED";
  }
}
