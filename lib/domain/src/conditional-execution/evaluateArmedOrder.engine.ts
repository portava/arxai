import { evaluateCondition } from "./evaluateCondition";
import type {
  ArmedOrder, ArmedOrderEvaluation, ConditionEvaluation, EvaluationContext,
  TickAction,
} from "./conditionalExecution.types";

// evaluateArmedOrder — single armed order, single tick.
//
// Decision precedence:
//   1. EXPIRE  if now > expiresAt (regardless of conditions)
//   2. Per combinator over condition statuses:
//        ALL — every condition SATISFIED → FIRE
//              any condition IMPOSSIBLE  → INVALIDATE
//              else                       → STILL_ARMED
//        ANY — any condition SATISFIED   → FIRE
//              every condition IMPOSSIBLE → INVALIDATE
//              else                       → STILL_ARMED
//
// INVALIDATE precedence (within ALL): an IMPOSSIBLE condition cannot be
// rescued by other conditions becoming SATISFIED, so we mark INVALIDATE
// even if some other conditions are satisfied. This is correct: the
// combinator demands all, and one is gone forever.
export function evaluateArmedOrder(
  order: ArmedOrder,
  ctx: EvaluationContext,
): ArmedOrderEvaluation {
  const reasons: string[] = [];

  // 1. Expiry first
  if (ctx.now.getTime() > Date.parse(order.expiresAt)) {
    reasons.push(`now ${ctx.now.toISOString()} > expiresAt ${order.expiresAt}`);
    return {
      armedOrderId: order.armedOrderId,
      action: "EXPIRE",
      conditionEvaluations: [],
      reasons,
    };
  }

  // 2. Evaluate every condition
  const conditionEvaluations: ConditionEvaluation[] = order.conditions.map((c) => evaluateCondition(c, ctx));

  const satisfiedCount = conditionEvaluations.filter((e) => e.status === "SATISFIED").length;
  const impossibleCount = conditionEvaluations.filter((e) => e.status === "PERMANENTLY_IMPOSSIBLE").length;
  const total = conditionEvaluations.length;

  let action: TickAction;
  if (order.combinator === "ALL") {
    if (impossibleCount > 0) {
      action = "INVALIDATE";
      reasons.push(`ALL combinator + ${impossibleCount} permanently-impossible condition(s) — invalidate`);
    } else if (satisfiedCount === total) {
      action = "FIRE";
      reasons.push(`ALL combinator + every condition (${total}) satisfied — fire`);
    } else {
      action = "STILL_ARMED";
      reasons.push(`ALL combinator: ${satisfiedCount}/${total} satisfied, ${impossibleCount} impossible — wait`);
    }
  } else {
    if (satisfiedCount > 0) {
      action = "FIRE";
      reasons.push(`ANY combinator + ${satisfiedCount} satisfied — fire`);
    } else if (impossibleCount === total) {
      action = "INVALIDATE";
      reasons.push(`ANY combinator + every condition impossible — invalidate`);
    } else {
      action = "STILL_ARMED";
      reasons.push(`ANY combinator: ${satisfiedCount}/${total} satisfied, ${impossibleCount} impossible — wait`);
    }
  }

  return {
    armedOrderId: order.armedOrderId,
    action,
    conditionEvaluations,
    reasons,
  };
}
