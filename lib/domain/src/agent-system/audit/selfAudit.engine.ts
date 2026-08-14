import type {
  AgentSystemSnapshot, ClosedTradeOutcome, GovernorReview, SelfAuditReport,
} from "../agentSystem.types";

// selfAudit — grades the SYSTEM (not the agents) on this trade.
// Looks for discipline gaps: governor overrides that turned out poorly,
// repeated kill-switch usage, ignored exit warnings.
export function runSelfAudit(
  snap: AgentSystemSnapshot,
  governor: GovernorReview,
  outcome: ClosedTradeOutcome,
): SelfAuditReport {
  const reasons: string[] = [];
  const flags: string[] = [];
  let score = 100;

  // Governor override that ended in loss = discipline question
  if (governor.verdict !== "APPROVE_AS_IS" && outcome.pnlR < 0) {
    score -= 15;
    flags.push("GOVERNOR_OVERRIDE_LOST");
    reasons.push("-15 — governor overrode and trade lost; review override criteria");
  }

  // Recent system-health pressure signals (if elevated and trade lost, score down)
  if (snap.policy.systemHealth.recentEmergencyKillCount >= 2) {
    score -= 10;
    flags.push("REPEATED_KILL_SWITCH");
    reasons.push(`-10 — ${snap.policy.systemHealth.recentEmergencyKillCount} emergency kills recently`);
  }
  if (snap.policy.systemHealth.recentIgnoredExitWarningCount >= 2 && outcome.pnlR < 0) {
    score -= 10;
    flags.push("EXIT_WARNINGS_IGNORED");
    reasons.push(`-10 — ${snap.policy.systemHealth.recentIgnoredExitWarningCount} exit warnings ignored recently AND trade lost`);
  }
  if (snap.policy.systemHealth.recentManualOverrideCount >= 3) {
    score -= 5;
    flags.push("OVERRIDE_PATTERN");
    reasons.push(`-5 — ${snap.policy.systemHealth.recentManualOverrideCount} manual overrides recently`);
  }

  // Emergency kill exit on this trade — pattern flag, not a discipline blame
  if (outcome.exitReason === "EMERGENCY_KILL") {
    flags.push("EMERGENCY_EXIT");
    reasons.push("trade closed by emergency kill — system-driven exit (no discipline penalty)");
  }

  score = Math.max(0, Math.min(100, score));
  reasons.push(`system discipline score ${score}/100`);
  return { systemDisciplineScore: score, flags, reasons };
}
