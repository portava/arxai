// Red Team — must challenge EVERY trade. Even a clean trade gets an
// "examined, no concrete challenge raised" pass. Pure function; no I/O.

import type {
  AgentSystemSnapshot, AgentVerdict, DirectionVerdict, HardBlockVerdict,
  QualityVerdict, TradeDirection,
} from "../agentSystem.types";
import type { RedTeamChallenge, RedTeamReport } from "../agentVote.types";

export function runRedTeam(
  snap: AgentSystemSnapshot,
  verdicts: AgentVerdict[],
  proposedDir: TradeDirection,
): RedTeamReport {
  const challenges: RedTeamChallenge[] = [];
  let n = 0;

  // 1. Vetoes are challenges (severity HIGH).
  for (const v of verdicts) {
    if (v.category === "HARD_BLOCK" && (v as HardBlockVerdict).vetoed) {
      challenges.push({
        challengeId: `R${++n}`, severity: "HIGH",
        reason: `${v.agentName} vetoed: ${(v as HardBlockVerdict).vetoReason ?? "unspecified"}`,
        addressedAgentId: v.agentId, evidence: v.reasons.slice(0, 3),
      });
    }
  }

  // 2. Direction agents voting AGAINST the proposed setup direction.
  for (const v of verdicts) {
    if (v.category !== "DIRECTION") continue;
    const d = v as DirectionVerdict;
    if (d.direction !== "ABSTAIN" && d.direction !== proposedDir && d.conviction >= 40) {
      challenges.push({
        challengeId: `R${++n}`, severity: d.conviction >= 70 ? "HIGH" : "MEDIUM",
        reason: `${d.agentName} disagrees with proposed ${proposedDir} (says ${d.direction} @ ${d.conviction.toFixed(0)})`,
        addressedAgentId: d.agentId, evidence: d.reasons.slice(0, 3),
      });
    }
  }

  // 3. Quality agents scoring the setup poorly.
  for (const v of verdicts) {
    if (v.category !== "QUALITY") continue;
    const q = v as QualityVerdict;
    if (q.qualityScore < 35) {
      challenges.push({
        challengeId: `R${++n}`,
        severity: q.qualityScore < 20 ? "HIGH" : "MEDIUM",
        reason: `${q.agentName} flags poor setup quality (${q.qualityScore.toFixed(0)}/100)`,
        addressedAgentId: q.agentId, evidence: q.reasons.slice(0, 3),
      });
    }
  }

  // 4. Macro/account context challenges (not tied to one agent).
  if (snap.behavior.consecutiveLosses >= 3) {
    challenges.push({
      challengeId: `R${++n}`, severity: "MEDIUM",
      reason: `recent loss streak of ${snap.behavior.consecutiveLosses} — revenge-trade risk`,
      addressedAgentId: null,
      evidence: [`emotional state: ${snap.behavior.emotionalState}`],
    });
  }
  if (snap.market.spreadPips >= snap.policy.maxSpreadPipsPolicy * 0.8) {
    challenges.push({
      challengeId: `R${++n}`, severity: "MEDIUM",
      reason: `spread ${snap.market.spreadPips.toFixed(1)}p approaching policy ceiling ${snap.policy.maxSpreadPipsPolicy}p`,
      addressedAgentId: null, evidence: [],
    });
  }

  const summary = challenges.length === 0
    ? "examined; no concrete challenge raised"
    : `${challenges.length} challenge(s) raised (${challenges.filter(c => c.severity === "HIGH").length} HIGH)`;

  return { challenges, examined: true, summary };
}
