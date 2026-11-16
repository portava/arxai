import type {
  ConditionEvaluation, EvaluationContext, RetestHoldsParamsSchema,
} from "../conditionalExecution.types";
import type { z } from "zod/v4";

type Params = z.infer<typeof RetestHoldsParamsSchema>;

// retestHolds — wait for price to RETEST a level and HOLD there.
//
// Stateless implementation: every call works from `recentTicks` since
// arming. Steps:
//   1. Find the FIRST tick that came within proximityPips of levelPrice.
//      No touch yet → PENDING (or PERMANENTLY_IMPOSSIBLE if price drifted
//      invalidationDistancePips away from the level without ever touching).
//   2. Compute adverse excursion (against trade direction) since first touch.
//      For BUY: how far BELOW levelPrice the lowest tick went.
//      For SELL: how far ABOVE levelPrice the highest tick went.
//      • If adverse > invalidationDistancePips → level broke → IMPOSSIBLE
//      • If adverse > maxRejectPips → rejected — PENDING (waiting for new touch)
//   3. Compute hold time (current tick observedAt − first-touch observedAt).
//      • If heldSeconds ≥ holdSeconds → SATISFIED
//      • Else → PENDING
export function evaluateRetestHolds(
  params: Params,
  ctx: EvaluationContext,
): ConditionEvaluation {
  const reasons: string[] = [];
  const ticks = ctx.recentTicks;
  const proximityPrice = params.proximityPips * ctx.pipSize;

  if (ticks.length === 0) {
    return { kind: "RETEST_HOLDS", status: "PENDING", reasons: ["no ticks observed since arming"] };
  }

  // ── 1. Find first touch ────────────────────────────────────────────────
  let firstTouchIdx = -1;
  for (let i = 0; i < ticks.length; i++) {
    if (Math.abs(ticks[i].currentPrice - params.levelPrice) <= proximityPrice) {
      firstTouchIdx = i;
      break;
    }
  }

  if (firstTouchIdx === -1) {
    // Pre-touch is ALWAYS PENDING. The validity window will EXPIRE the
    // armed order if no retest ever happens — invalidation here is
    // reserved for adverse excursion AFTER first touch (level broke).
    const distPips = Math.abs(ctx.currentTick.currentPrice - params.levelPrice) / ctx.pipSize;
    reasons.push(`awaiting retest of "${params.levelLabel}" @ ${params.levelPrice} (currently ${distPips.toFixed(1)}p away)`);
    return { kind: "RETEST_HOLDS", status: "PENDING", reasons };
  }

  // ── 2. Adverse excursion since first touch ─────────────────────────────
  const sinceTouch = ticks.slice(firstTouchIdx);
  const lowestSince  = Math.min(...sinceTouch.map((t) => t.currentPrice));
  const highestSince = Math.max(...sinceTouch.map((t) => t.currentPrice));
  const adversePips = ctx.tradeDirection === "BUY"
    ? Math.max(0, params.levelPrice - lowestSince)  / ctx.pipSize
    : Math.max(0, highestSince - params.levelPrice) / ctx.pipSize;

  if (adversePips > params.invalidationDistancePips) {
    reasons.push(`adverse ${adversePips.toFixed(1)}p past level — level broke — IMPOSSIBLE`);
    return { kind: "RETEST_HOLDS", status: "PERMANENTLY_IMPOSSIBLE", reasons };
  }
  if (adversePips > params.maxRejectPips) {
    reasons.push(`rejected ${adversePips.toFixed(1)}p > maxReject ${params.maxRejectPips}p — waiting for new touch`);
    return { kind: "RETEST_HOLDS", status: "PENDING", reasons };
  }

  // ── 3. Hold time ───────────────────────────────────────────────────────
  const heldSeconds = (Date.parse(ctx.currentTick.observedAt) - Date.parse(sinceTouch[0].observedAt)) / 1000;
  if (heldSeconds >= params.holdSeconds) {
    reasons.push(`held at "${params.levelLabel}" for ${heldSeconds.toFixed(0)}s ≥ ${params.holdSeconds}s, max adverse ${adversePips.toFixed(1)}p`);
    return { kind: "RETEST_HOLDS", status: "SATISFIED", reasons };
  }
  reasons.push(`holding ${heldSeconds.toFixed(0)}s / ${params.holdSeconds}s, adverse ${adversePips.toFixed(1)}p`);
  return { kind: "RETEST_HOLDS", status: "PENDING", reasons };
}
