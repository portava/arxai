import type {
  AgentVerdict, DebateReport, DecisionExplanation, HardBlockVerdict,
  ProposedDecision,
} from "../agentSystem.types";

// decisionExplanation — produces a human-readable rationale.
// The headline is single-line summary; bullets enumerate the contributing
// agent calls; cautionFlags surface anything the operator should double-check.
export function explainDecision(
  decision: ProposedDecision,
  verdicts: AgentVerdict[],
  debate: DebateReport,
): DecisionExplanation {
  const bullets: string[] = [];
  const cautionFlags: string[] = [];
  let headline: string;

  switch (decision.action) {
    case "APPROVE":
      headline = `APPROVE ${decision.direction} @ confidence ${decision.confidence.toFixed(0)} (size ×${decision.sizeMultiplier.toFixed(2)})`;
      break;
    case "APPROVE_REDUCED":
      headline = `APPROVE_REDUCED ${decision.direction} @ confidence ${decision.confidence.toFixed(0)} (size ×${decision.sizeMultiplier.toFixed(2)})`;
      cautionFlags.push("size reduced — quality below execute floor");
      break;
    case "REJECT":
      headline = `REJECT — ${decision.rationale[0] ?? "no rationale"}`;
      break;
  }

  for (const v of verdicts) {
    if (v.category === "HARD_BLOCK") {
      const b = v as HardBlockVerdict;
      bullets.push(`[${b.agentName}] ${b.vetoed ? `VETO — ${b.vetoReason}` : "pass"}`);
    } else if (v.category === "DIRECTION") {
      bullets.push(`[${v.agentName}] ${v.direction}@${v.conviction.toFixed(0)}`);
    } else if (v.category === "QUALITY") {
      bullets.push(`[${v.agentName}] quality ${v.qualityScore.toFixed(0)}`);
    }
  }

  if (debate.conflicts.length > 0) {
    cautionFlags.push(`${debate.conflicts.length} agent conflict(s) — see debate report`);
  }
  if (debate.directionalAgreement01 < 0.7 && decision.action !== "REJECT") {
    cautionFlags.push(`directional agreement only ${(debate.directionalAgreement01 * 100).toFixed(0)}%`);
  }
  if (debate.qualityDispersion01 > 0.4) {
    cautionFlags.push(`wide quality dispersion (${(debate.qualityDispersion01 * 100).toFixed(0)}%)`);
  }

  return { headline, bullets, cautionFlags };
}
