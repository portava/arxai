import type {
  AgentGrade, AgentPerformanceReport, AgentVerdict, ClosedTradeOutcome,
  DirectionVerdict, HardBlockVerdict, QualityVerdict,
} from "../agentSystem.types";

// agentPerformance — grades EVERY agent that contributed to the entry.
// Direction agents get RIGHT/WRONG by the realized winning direction.
// Quality agents get scored against the actual outcome quality.
// Hard-block agents that didn't veto get NEUTRAL; that did veto on a
// trade that nevertheless executed are flagged as WRONG.
export function gradeAgentPerformance(
  verdicts: AgentVerdict[],
  outcome: ClosedTradeOutcome,
): AgentPerformanceReport {
  const reasons: string[] = [];
  const grades: AgentGrade[] = [];

  // Winning direction
  const ambiguous = Math.abs(outcome.pnlR) <= 0.25;
  let winningDirection: "BUY" | "SELL" | null;
  if (ambiguous) winningDirection = null;
  else if (outcome.pnlR > 0) winningDirection = outcome.direction;
  else winningDirection = outcome.direction === "BUY" ? "SELL" : "BUY";

  // Ambiguous outcomes (|pnlR| ≤ 0.25) are not informative enough to grade
  // ANY agent — RIGHT/WRONG attribution from a near-zero result is noise.
  // All agents across all 3 categories collapse to ABSTAINED with neutral
  // score 50 and a uniform reason. This is the spec rule.
  if (ambiguous) {
    for (const v of verdicts) {
      grades.push({
        agentId: v.agentId, agentName: v.agentName, category: v.category,
        contribution: "ABSTAINED", score: 50,
        reasons: [`outcome ambiguous (|${outcome.pnlR.toFixed(2)}R| ≤ 0.25) — no agent graded`],
      });
    }
    reasons.push(`ambiguous outcome — all ${verdicts.length} agents marked ABSTAINED`);
    return { grades, topRight: null, topWrong: null, reasons };
  }

  for (const v of verdicts) {
    if (v.category === "HARD_BLOCK") {
      const b = v as HardBlockVerdict;
      // If the trade executed (we're auditing), no veto fired through to
      // governor — but an agent that vetoed and was overridden by the
      // governor's independent rules still gets graded.
      grades.push({
        agentId: b.agentId, agentName: b.agentName, category: "HARD_BLOCK",
        contribution: b.vetoed ? (outcome.pnlR > 0 ? "WRONG" : "RIGHT") : "NEUTRAL",
        score: b.vetoed ? (outcome.pnlR > 0 ? 25 : 75) : 50,
        reasons: [b.vetoed
          ? `vetoed — outcome was ${outcome.pnlR.toFixed(2)}R; veto was ${outcome.pnlR > 0 ? "wrong" : "right"}`
          : "did not veto — neutral on outcome"],
      });
    } else if (v.category === "DIRECTION") {
      const d = v as DirectionVerdict;
      if (d.direction === "ABSTAIN") {
        grades.push({
          agentId: d.agentId, agentName: d.agentName, category: "DIRECTION",
          contribution: "ABSTAINED", score: 50,
          reasons: ["agent abstained at decision time"],
        });
      } else if (d.direction === winningDirection) {
        const score = 50 + (d.conviction / 100) * 50;
        grades.push({
          agentId: d.agentId, agentName: d.agentName, category: "DIRECTION",
          contribution: "RIGHT", score,
          reasons: [`called ${d.direction} @ ${d.conviction.toFixed(0)} — matched outcome`],
        });
      } else {
        const score = Math.max(0, 50 - (d.conviction / 100) * 50);
        grades.push({
          agentId: d.agentId, agentName: d.agentName, category: "DIRECTION",
          contribution: "WRONG", score,
          reasons: [`called ${d.direction} @ ${d.conviction.toFixed(0)} — outcome went ${winningDirection}`],
        });
      }
    } else {
      const q = v as QualityVerdict;
      // Quality grade: did high quality predict good outcome and vice versa?
      const qualityHigh = q.qualityScore >= 60;
      const tradeGood = outcome.pnlR > 0.5;
      const tradeBad = outcome.pnlR < -0.5;
      let contribution: AgentGrade["contribution"] = "NEUTRAL";
      let score = 50;
      if (qualityHigh && tradeGood) { contribution = "RIGHT"; score = 75; }
      else if (!qualityHigh && tradeBad) { contribution = "RIGHT"; score = 70; }
      else if (qualityHigh && tradeBad) { contribution = "WRONG"; score = 30; }
      else if (!qualityHigh && tradeGood) { contribution = "WRONG"; score = 35; }
      grades.push({
        agentId: q.agentId, agentName: q.agentName, category: "QUALITY",
        contribution, score,
        reasons: [`quality ${q.qualityScore.toFixed(0)} vs outcome ${outcome.pnlR.toFixed(2)}R`],
      });
    }
  }

  const right = grades.filter((g) => g.contribution === "RIGHT");
  const wrong = grades.filter((g) => g.contribution === "WRONG");
  right.sort((a, b) => b.score - a.score);
  wrong.sort((a, b) => a.score - b.score);

  reasons.push(`${right.length} right, ${wrong.length} wrong, ${grades.length - right.length - wrong.length} neutral/abstained`);
  return {
    grades,
    topRight: right[0]?.agentName ?? null,
    topWrong: wrong[0]?.agentName ?? null,
    reasons,
  };
}
