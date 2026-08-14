import type { AgentSystemSnapshot, QualityVerdict } from "../agentSystem.types";

// Session Agent — quality score from current session vs symbol's preferred sessions.
export function sessionAgent(snap: AgentSystemSnapshot): QualityVerdict {
  const reasons: string[] = [];
  const cur = snap.policy.currentSession;
  const prefs = snap.policy.symbolPreferredSessions;
  let qualityScore: number;

  if (prefs.length === 0) {
    qualityScore = 60;
    reasons.push("symbol has no preferred sessions — neutral 60");
  } else if (prefs.includes(cur)) {
    qualityScore = 85;
    reasons.push(`session ${cur} is preferred — quality 85`);
  } else if (cur === "OFF_HOURS") {
    qualityScore = 25;
    reasons.push(`OFF_HOURS — quality 25`);
  } else {
    qualityScore = 45;
    reasons.push(`session ${cur} not preferred (prefers ${prefs.join(",")}) — quality 45`);
  }

  return {
    agentId: "SESSION", agentName: "Session Agent", category: "QUALITY",
    qualityScore, reasons, observedAt: snap.now.toISOString(),
  };
}
