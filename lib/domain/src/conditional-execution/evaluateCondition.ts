import { evaluateCandleCloses } from "./conditions/candleCloses.condition";
import { evaluateLiquiditySweep } from "./conditions/liquiditySweep.condition";
import { evaluateRetestHolds } from "./conditions/retestHolds.condition";
import { evaluateSpreadBelow } from "./conditions/spreadBelow.condition";
import type {
  ConditionEvaluation, ConditionParams, EvaluationContext,
} from "./conditionalExecution.types";

// evaluateCondition — dispatches to the per-kind evaluator. Exhaustive
// switch — adding a new condition kind is a compile error here, which is
// intentional (forces the new kind to be wired in).
export function evaluateCondition(
  params: ConditionParams,
  ctx: EvaluationContext,
): ConditionEvaluation {
  switch (params.kind) {
    case "RETEST_HOLDS":     return evaluateRetestHolds(params, ctx);
    case "SPREAD_BELOW":     return evaluateSpreadBelow(params, ctx);
    case "CANDLE_CLOSES":    return evaluateCandleCloses(params, ctx);
    case "LIQUIDITY_SWEEP":  return evaluateLiquiditySweep(params, ctx);
  }
}
