import type {
  ConditionEvaluation, EvaluationContext, SpreadBelowParamsSchema,
} from "../conditionalExecution.types";
import type { z } from "zod/v4";

type Params = z.infer<typeof SpreadBelowParamsSchema>;

// spreadBelow — execution-quality gate: wait for spread to drop below X.
// Never permanently impossible — spread can always recover. The validity
// window will EXPIRE the order if spread stays high too long.
export function evaluateSpreadBelow(
  params: Params,
  ctx: EvaluationContext,
): ConditionEvaluation {
  const cur = ctx.currentTick.spreadPips;
  if (cur < params.maxSpreadPips) {
    return {
      kind: "SPREAD_BELOW", status: "SATISFIED",
      reasons: [`spread ${cur.toFixed(1)}p < target ${params.maxSpreadPips}p`],
    };
  }
  return {
    kind: "SPREAD_BELOW", status: "PENDING",
    reasons: [`spread ${cur.toFixed(1)}p ≥ target ${params.maxSpreadPips}p — waiting`],
  };
}
