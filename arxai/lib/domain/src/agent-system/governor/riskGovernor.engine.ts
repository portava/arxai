import { getHardBlockRules } from "./hardBlockRules.engine";
import type {
  AgentSystemSnapshot, GovernorReview, ProposedDecision,
} from "../agentSystem.types";

// riskGovernor — has FINAL authority. Can override the judge's decision.
//
// Independence: the governor evaluates hard-block rules INDEPENDENTLY of
// the agents. Even if every agent passed, a fired rule rejects. This is
// the architectural safety net — agents can be wrong, the governor is
// rule-based and predictable.
//
// Decision matrix:
//   • Any hard-block rule fired       → OVERRIDE_REJECT
//   • Judge proposed REJECT           → APPROVE_AS_IS (can't approve a rejection;
//                                       governor concurs)
//   • Judge proposed APPROVE_REDUCED  → APPROVE_AS_IS, no override
//   • Judge proposed APPROVE
//       AND any quality caution       → OVERRIDE_REDUCE (cap at 0.75×)
//       OR  proposed risk > 80% of ceiling → OVERRIDE_REDUCE (back off)
//       OTHERWISE                     → APPROVE_AS_IS
export function riskGovernor(
  snap: AgentSystemSnapshot,
  proposed: ProposedDecision,
): GovernorReview {
  const reasons: string[] = [];
  const overrideReasons: string[] = [];
  const hardBlocksTriggered: string[] = [];

  for (const rule of getHardBlockRules()) {
    const r = rule.evaluate(snap);
    if (r.fired) {
      hardBlocksTriggered.push(rule.ruleId);
      reasons.push(`HARD BLOCK [${rule.ruleId}] — ${r.reason ?? "fired"}`);
    }
  }

  if (hardBlocksTriggered.length > 0) {
    overrideReasons.push(`${hardBlocksTriggered.length} hard-block rule(s) fired — overriding to REJECT`);
    return {
      verdict: "OVERRIDE_REJECT", finalAction: "REJECT", finalSizeMultiplier: 0,
      hardBlocksTriggered, overrideReasons, reasons,
    };
  }

  if (proposed.action === "REJECT") {
    reasons.push("judge proposed REJECT — governor concurs");
    return {
      verdict: "APPROVE_AS_IS", finalAction: "REJECT", finalSizeMultiplier: 0,
      hardBlocksTriggered, overrideReasons, reasons,
    };
  }

  // APPROVE / APPROVE_REDUCED path — consider risk-based reduction
  let finalSizeMultiplier = proposed.sizeMultiplier;
  let verdict: GovernorReview["verdict"] = "APPROVE_AS_IS";
  let finalAction = proposed.action;

  // Back off when proposed risk is close to per-trade ceiling
  const riskUsageRatio = snap.policy.maxSingleTradeRiskPct > 0
    ? snap.setup.proposedRiskPct / snap.policy.maxSingleTradeRiskPct
    : 0;
  if (proposed.action === "APPROVE" && riskUsageRatio > 0.80) {
    verdict = "OVERRIDE_REDUCE";
    finalAction = "APPROVE_REDUCED";
    finalSizeMultiplier = Math.min(proposed.sizeMultiplier, 0.75);
    overrideReasons.push(`risk usage ${(riskUsageRatio * 100).toFixed(0)}% of ceiling — reducing size to ×${finalSizeMultiplier.toFixed(2)}`);
  }

  // Back off when confidence is high but quality reasoning suggests caution
  if (proposed.action === "APPROVE" && proposed.confidence < 55) {
    verdict = "OVERRIDE_REDUCE";
    finalAction = "APPROVE_REDUCED";
    finalSizeMultiplier = Math.min(finalSizeMultiplier, 0.75);
    overrideReasons.push(`judge confidence ${proposed.confidence.toFixed(0)} < 55 — reducing to ×${finalSizeMultiplier.toFixed(2)}`);
  }

  reasons.push(`governor verdict ${verdict}, final ${finalAction} ×${finalSizeMultiplier.toFixed(2)}`);
  return {
    verdict, finalAction, finalSizeMultiplier,
    hardBlocksTriggered, overrideReasons, reasons,
  };
}
