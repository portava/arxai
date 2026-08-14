import type {
  CourtSession, Lesson, LessonSeverity,
} from "./tradeCourt.types";

// extractLessons — pull structured lessons from a CourtSession. Lessons
// are tagged + severity'd so they can be grouped and queried later.
//
// Patterns surfaced:
//   • OVERCONFIDENT_WRONG    — contributor was WRONG with conviction ≥ 70
//   • SILENT_WHEN_NEEDED     — contributor ABSTAINED on a clearly-decided trade
//   • OVERRIDDEN_AND_RIGHT   — contributor BLOCKED, trade executed anyway, lost
//   • OVERRIDDEN_AND_WRONG   — contributor BLOCKED, trade executed anyway, won
//   • SYSTEM_NET_LOSS        — overall netGradeScore < -50
//   • SYSTEM_NET_WIN         — overall netGradeScore > +50
export function extractLessons(
  session: CourtSession,
  generateLessonId: () => string,
  recordedAt: string = new Date().toISOString(),
): Lesson[] {
  const out: Lesson[] = [];
  const push = (contributorId: string | null, tag: string, severity: LessonSeverity, message: string) => {
    out.push({
      lessonId: generateLessonId(),
      decisionId: session.decisionId,
      contributorId, tag, severity, message,
      recordedAt,
    });
  };

  for (const r of session.rulings) {
    if (r.grade === "WRONG" && Math.abs(r.scoreDelta) >= 70) {
      push(r.contributorId, "OVERCONFIDENT_WRONG", "WARN",
        `${r.contributorName} was WRONG with conviction ${Math.abs(r.scoreDelta).toFixed(0)} — review confidence calibration in this regime`);
    }
    if (r.grade === "ABSTAINED" && session.outcome.pnlR !== 0 && Math.abs(session.outcome.pnlR) > 0.5) {
      push(r.contributorId, "SILENT_WHEN_NEEDED", "INFO",
        `${r.contributorName} abstained on a decisive ${session.outcome.pnlR.toFixed(2)}R trade — coverage gap`);
    }
    if (r.stance === "BLOCKED" && r.grade === "RIGHT") {
      push(r.contributorId, "OVERRIDDEN_AND_RIGHT", "CRITICAL",
        `${r.contributorName} blocked correctly; trade executed anyway and lost — review override criteria`);
    }
    if (r.stance === "BLOCKED" && r.grade === "WRONG") {
      push(r.contributorId, "OVERRIDDEN_AND_WRONG", "INFO",
        `${r.contributorName} blocked but the trade won — block was wrong this time`);
    }
  }

  if (session.netGradeScore < -50) {
    push(null, "SYSTEM_NET_LOSS", "WARN",
      `system net grade ${session.netGradeScore.toFixed(0)} on ${session.outcome.pnlR.toFixed(2)}R — most contributors were wrong`);
  } else if (session.netGradeScore > 50) {
    push(null, "SYSTEM_NET_WIN", "INFO",
      `system net grade +${session.netGradeScore.toFixed(0)} on ${session.outcome.pnlR.toFixed(2)}R — most contributors were right`);
  }

  return out;
}
