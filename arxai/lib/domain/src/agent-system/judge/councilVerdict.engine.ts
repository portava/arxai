// councilVerdict — maps the existing ProposedDecision (APPROVE /
// APPROVE_REDUCED / REJECT) plus debate signals onto the Phase 3 council
// vocabulary of 7 verdicts:
//   EXECUTE | WAIT | REDUCE_SIZE | MONITOR_ONLY | SOFT_BLOCK | HARD_BLOCK | EXECUTE_IF
//
// Routing rules (evaluated in order):
//   1. Any CRITICAL agent (RISK / EXEC / NEWS) vetoed     → HARD_BLOCK
//   2. Any non-critical hard-block agent vetoed           → SOFT_BLOCK
//   3. Judge action == REJECT (quality/consensus failure) → SOFT_BLOCK
//   4. Disagreement >= 0.6                                → WAIT
//   5. Judge action == APPROVE_REDUCED                    → REDUCE_SIZE
//   6. BlueTeam emitted conditions[]                      → EXECUTE_IF
//   7. Confidence < 55 with conflicts/disagreement>0.4    → MONITOR_ONLY
//   8. Otherwise                                          → EXECUTE

import type { AgentVerdict, DebateReport, HardBlockVerdict, ProposedDecision }
  from "../agentSystem.types";
import {
  CRITICAL_AGENT_IDS,
  type BlueTeamReport, type CouncilDecision, type CouncilVerdict,
  type RedTeamReport,
} from "../agentVote.types";

export interface CouncilVerdictInput {
  agentVerdicts: AgentVerdict[];
  proposed: ProposedDecision;
  debate: DebateReport;
  disagreementScore01: number;
  redTeam: RedTeamReport;
  blueTeam: BlueTeamReport;
}

export function mapToCouncilVerdict(input: CouncilVerdictInput): CouncilDecision {
  const { agentVerdicts, proposed, debate, disagreementScore01, redTeam, blueTeam } = input;
  const reasoning: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const vetoed = agentVerdicts.filter((v): v is HardBlockVerdict =>
    v.category === "HARD_BLOCK" && v.vetoed);
  const criticalVeto = vetoed.filter(b => CRITICAL_AGENT_IDS.has(b.agentId));
  for (const v of vetoed) {
    blockers.push(`${v.agentName}: ${v.vetoReason ?? "veto"}`);
  }

  let verdict: CouncilVerdict;

  if (criticalVeto.length > 0) {
    verdict = "HARD_BLOCK";
    reasoning.push(`HARD_BLOCK — critical agent veto: ${criticalVeto.map(v => v.agentName).join(", ")}`);
  } else if (vetoed.length > 0) {
    verdict = "SOFT_BLOCK";
    reasoning.push(`SOFT_BLOCK — non-critical veto: ${vetoed.map(v => v.agentName).join(", ")}`);
  } else if (proposed.action === "REJECT") {
    verdict = "SOFT_BLOCK";
    reasoning.push(`SOFT_BLOCK — judge rejected: ${proposed.rationale[0] ?? "no consensus"}`);
  } else if (disagreementScore01 >= 0.6) {
    verdict = "WAIT";
    reasoning.push(`WAIT — high council disagreement (${(disagreementScore01 * 100).toFixed(0)}%)`);
  } else if (proposed.action === "APPROVE_REDUCED") {
    verdict = "REDUCE_SIZE";
    reasoning.push(`REDUCE_SIZE — judge approved with reduced size (×${proposed.sizeMultiplier.toFixed(2)})`);
  } else if (blueTeam.conditions.length > 0) {
    verdict = "EXECUTE_IF";
    reasoning.push(`EXECUTE_IF — ${blueTeam.conditions.length} condition(s) attached by Blue Team`);
  } else if (proposed.confidence < 55
          && (debate.conflicts.length > 0 || disagreementScore01 > 0.4)) {
    verdict = "MONITOR_ONLY";
    reasoning.push(`MONITOR_ONLY — borderline confidence ${proposed.confidence.toFixed(0)} with conflicts`);
  } else {
    verdict = "EXECUTE";
    reasoning.push(`EXECUTE — clean approval (confidence ${proposed.confidence.toFixed(0)}, disagreement ${(disagreementScore01 * 100).toFixed(0)}%)`);
  }

  // Warnings (always informational; never change the verdict).
  if (debate.conflicts.length > 0) warnings.push(`${debate.conflicts.length} conflict(s) in debate`);
  if (debate.directionalAgreement01 < 0.7) warnings.push(`directional agreement only ${(debate.directionalAgreement01 * 100).toFixed(0)}%`);
  if (debate.qualityDispersion01 > 0.4) warnings.push(`wide quality dispersion (${(debate.qualityDispersion01 * 100).toFixed(0)}%)`);
  if (redTeam.challenges.some(c => c.severity === "HIGH")) {
    warnings.push(`${redTeam.challenges.filter(c => c.severity === "HIGH").length} HIGH-severity Red Team challenge(s)`);
  }

  return {
    verdict,
    proposedDirection: proposed.direction,
    confidence01: Math.max(0, Math.min(1, proposed.confidence / 100)),
    sizeMultiplier: verdict === "EXECUTE" || verdict === "REDUCE_SIZE" || verdict === "EXECUTE_IF"
      ? proposed.sizeMultiplier : 0,
    reasoning, blockers, warnings,
    conditions: verdict === "EXECUTE_IF" ? blueTeam.conditions : [],
  };
}
