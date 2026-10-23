import type {
  LivePositionInput,
  LivePositionStatus,
  PositionRiskVerdict,
  RiskWarning,
} from "./types.js";

// Thresholds (kept centralised for review).
const PRICE_NEAR_SL_PCT = 0.20;          // <20% remaining distance to SL → warn
const REWARD_RISK_LOW_FLOOR = 1.0;       // RR < 1.0 → warn
const EXPOSURE_DANGER_PCT = 0.05;        // notional / equity > 5% → warn
const CORRELATED_DANGER_COUNT = 2;       // 2+ correlated open trades → warn

/**
 * Evaluate live position risk. Pure: no I/O. Caller derives `correlatedOpenCount`
 * and `stopLossWasRemoved` upstream by diffing the previous snapshot.
 */
export function evaluateLivePosition(
  input: LivePositionInput,
  prevStatus: LivePositionStatus,
): PositionRiskVerdict {
  const warnings: RiskWarning[] = [];
  const blockers: string[] = [];

  // ── Status classification ──────────────────────────────────────────────
  let status: LivePositionStatus = prevStatus;
  if (input.currentPrice == null) {
    status = "SYNC_PENDING";
  } else if (input.stopLoss != null && hitStop(input)) {
    status = "STOP_LOSS_HIT";
  } else if (input.takeProfit != null && hitTake(input)) {
    status = "TAKE_PROFIT_HIT";
  } else if (prevStatus === "SYNC_PENDING" || prevStatus === "OPEN" || prevStatus === "PARTIALLY_CLOSED") {
    status = prevStatus === "SYNC_PENDING" ? "OPEN" : prevStatus;
  }

  // ── P&L + RR ───────────────────────────────────────────────────────────
  const sign = input.direction === "BUY" ? 1 : -1;
  const unrealizedPnL = input.currentPrice == null
    ? null
    : (input.currentPrice - input.entryPrice) * sign * input.lotSize;
  const rewardToRisk = computeRR(input);

  // ── SL proximity (only meaningful while OPEN-ish) ─────────────────────
  const slProximity = computeSlProximity(input);

  // ── Warnings ───────────────────────────────────────────────────────────
  if (input.stopLossWasRemoved) {
    warnings.push({
      code: "STOP_LOSS_REMOVED",
      severity: "DANGER",
      message: "Stop loss has been removed from this position.",
      aiExplanation: "Removing your stop loss is the most common way disciplined traders blow accounts. Re-attach a stop unless your original setup is still valid.",
    });
    blockers.push("stop loss removed");
  }
  if (slProximity != null && slProximity >= 0 && slProximity <= PRICE_NEAR_SL_PCT) {
    warnings.push({
      code: "PRICE_NEAR_SL",
      severity: "WARN",
      message: `Price is within ${Math.round(slProximity * 100)}% of stop loss.`,
      aiExplanation: "Your position is approaching stop loss. Do not widen risk unless your original setup is still valid.",
    });
  }
  if (rewardToRisk != null && rewardToRisk < REWARD_RISK_LOW_FLOOR && status === "OPEN") {
    warnings.push({
      code: "REWARD_RISK_LOW",
      severity: "INFO",
      message: `Reward-to-risk is ${rewardToRisk.toFixed(2)}.`,
      aiExplanation: "Reward-to-risk is below 1.0. Consider whether this exit plan still justifies the downside.",
    });
  }
  if (input.accountEquity && input.accountEquity > 0) {
    const notional = Math.abs(input.lotSize * input.entryPrice);
    const exposurePct = notional / input.accountEquity;
    if (exposurePct >= EXPOSURE_DANGER_PCT) {
      warnings.push({
        code: "EXPOSURE_HIGH",
        severity: "WARN",
        message: `Position exposure is ${(exposurePct * 100).toFixed(1)}% of equity.`,
        aiExplanation: "Lot size exposure on this position is high. A single adverse move can dent your account meaningfully.",
      });
    }
  }
  if (input.correlatedOpenCount >= CORRELATED_DANGER_COUNT) {
    warnings.push({
      code: "CORRELATED_TRADES",
      severity: "WARN",
      message: `${input.correlatedOpenCount} correlated open positions detected.`,
      aiExplanation: "You currently have multiple positions exposed to the same market direction. Treat the basket as one trade for sizing.",
    });
  }
  if (
    input.currentPrice != null && input.stopLoss != null &&
    isAdverse(input)
  ) {
    warnings.push({
      code: "ADVERSE_DRIFT",
      severity: "INFO",
      message: "Price is drifting against the position.",
      aiExplanation: "Price is moving against you but the stop is still intact. Hold the original plan unless invalidated.",
    });
  }

  return { status, unrealizedPnL, rewardToRisk, slProximity, warnings, blockers };
}

// ── helpers ──────────────────────────────────────────────────────────────

function hitStop(i: LivePositionInput): boolean {
  if (i.currentPrice == null || i.stopLoss == null) return false;
  return i.direction === "BUY" ? i.currentPrice <= i.stopLoss : i.currentPrice >= i.stopLoss;
}
function hitTake(i: LivePositionInput): boolean {
  if (i.currentPrice == null || i.takeProfit == null) return false;
  return i.direction === "BUY" ? i.currentPrice >= i.takeProfit : i.currentPrice <= i.takeProfit;
}
function isAdverse(i: LivePositionInput): boolean {
  if (i.currentPrice == null) return false;
  return i.direction === "BUY" ? i.currentPrice < i.entryPrice : i.currentPrice > i.entryPrice;
}
function computeRR(i: LivePositionInput): number | null {
  if (i.stopLoss == null || i.takeProfit == null) return null;
  const risk = Math.abs(i.entryPrice - i.stopLoss);
  const reward = Math.abs(i.takeProfit - i.entryPrice);
  if (risk <= 0) return null;
  return reward / risk;
}
/** Returns 1.0 when price is at entry, 0.0 at stop, negative if past stop. */
function computeSlProximity(i: LivePositionInput): number | null {
  if (i.currentPrice == null || i.stopLoss == null) return null;
  const total = Math.abs(i.entryPrice - i.stopLoss);
  if (total <= 0) return null;
  const fromSL = i.direction === "BUY"
    ? i.currentPrice - i.stopLoss
    : i.stopLoss - i.currentPrice;
  return Math.max(-1, Math.min(1, fromSL / total));
}
