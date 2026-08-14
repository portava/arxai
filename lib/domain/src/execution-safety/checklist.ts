import type { ChecklistInputs, ChecklistResult, ChecklistReason } from "./types.js";

/**
 * Pure pre-trade checklist evaluator.
 *
 * Composes order intent + Build D permission verdict + MT5 connection state +
 * market condition + practice-mode flag into a single APPROVED / WARN /
 * BLOCKED verdict. No I/O. No DB. The route layer wires real inputs.
 *
 * Hard blockers (verdict = BLOCKED, cannot proceed):
 *   - permissionStatus = LOCKED or LIVE_TRADING_DISABLED
 *   - brokerConnected = false
 *   - marketCondition = NO_TRADE
 *   - practiceMode = true (replay/practice cannot reach live broker)
 *   - lotSize ≤ 0, > maxLotSize, or invalid
 *   - SL on wrong side of entry
 *   - TP on wrong side of entry
 *   - estimatedRisk > maxRiskPerTradePct of accountBalance
 *   - spread > maxAcceptableSpread
 *
 * Warnings (verdict = WARN, user may proceed with explicit confirmation):
 *   - permissionStatus = CAUTION
 *   - aiConfidence below minConfidence
 *   - reward-to-risk < 1.0
 *   - bubbled permissionBlockers when status is CAUTION
 */
export function evaluateChecklist(inputs: ChecklistInputs): ChecklistResult {
  const reasons: ChecklistReason[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // ── Distances + risk math ──────────────────────────────────────────────
  const isBuy = inputs.direction === "BUY";
  const slDistance = Math.abs(inputs.entryPrice - inputs.stopLoss);
  const tpDistance = Math.abs(inputs.takeProfit - inputs.entryPrice);
  const rewardToRisk = slDistance > 0 ? tpDistance / slDistance : 0;

  // Estimated risk (dollars) = lot * slDistance * pip_value_proxy.
  // Pure module: callers can pre-compute exact risk. We use a $1/pip proxy when
  // the caller provides distances in price units; this is the same heuristic
  // riskAudit.ts uses for synthetic-volatility instruments.
  const estimatedRisk = inputs.lotSize * slDistance;

  // ── Hard blockers ──────────────────────────────────────────────────────
  if (inputs.permissionStatus === "LOCKED") {
    const m = `Trading permission is LOCKED — ${inputs.permissionBlockers[0] ?? "see Risk Center"}.`;
    blockers.push(m);
    reasons.push({ code: "PERMISSION_LOCKED", severity: "BLOCK", message: m });
  }
  if (inputs.permissionStatus === "LIVE_TRADING_DISABLED") {
    const m = "Live trading is disabled in this build (OBSERVE_ONLY + PAPER_TRADING).";
    blockers.push(m);
    reasons.push({ code: "LIVE_TRADING_DISABLED", severity: "BLOCK", message: m });
  }

  if (!inputs.brokerConnected) {
    const m = "Broker / MT5 is not connected.";
    blockers.push(m);
    reasons.push({ code: "BROKER_DISCONNECTED", severity: "BLOCK", message: m });
  }

  if (inputs.marketCondition === "NO_TRADE") {
    const m = "Current market condition is NO TRADE.";
    blockers.push(m);
    reasons.push({ code: "MARKET_NO_TRADE", severity: "BLOCK", message: m });
  }

  if (inputs.practiceMode) {
    const m = "Practice / replay mode is active — cannot route to live broker.";
    blockers.push(m);
    reasons.push({ code: "PRACTICE_MODE_ACTIVE", severity: "BLOCK", message: m });
  }

  // Lot size validation
  if (!Number.isFinite(inputs.lotSize) || inputs.lotSize <= 0) {
    const m = `Lot size is invalid (${inputs.lotSize}).`;
    blockers.push(m);
    reasons.push({ code: "LOT_INVALID", severity: "BLOCK", message: m });
  } else if (inputs.lotSize > inputs.maxLotSize) {
    const m = `Lot size ${inputs.lotSize} exceeds the maximum allowed ${inputs.maxLotSize}.`;
    blockers.push(m);
    reasons.push({ code: "LOT_TOO_LARGE", severity: "BLOCK", message: m });
  }

  // SL/TP geometry
  if (slDistance <= 0) {
    const m = "Stop loss must differ from entry price.";
    blockers.push(m);
    reasons.push({ code: "SL_INVALID", severity: "BLOCK", message: m });
  } else if (isBuy && inputs.stopLoss >= inputs.entryPrice) {
    const m = "Stop loss must be below entry for a BUY.";
    blockers.push(m);
    reasons.push({ code: "SL_WRONG_SIDE", severity: "BLOCK", message: m });
  } else if (!isBuy && inputs.stopLoss <= inputs.entryPrice) {
    const m = "Stop loss must be above entry for a SELL.";
    blockers.push(m);
    reasons.push({ code: "SL_WRONG_SIDE", severity: "BLOCK", message: m });
  }

  if (tpDistance <= 0) {
    const m = "Take profit must differ from entry price.";
    blockers.push(m);
    reasons.push({ code: "TP_INVALID", severity: "BLOCK", message: m });
  } else if (isBuy && inputs.takeProfit <= inputs.entryPrice) {
    const m = "Take profit must be above entry for a BUY.";
    blockers.push(m);
    reasons.push({ code: "TP_WRONG_SIDE", severity: "BLOCK", message: m });
  } else if (!isBuy && inputs.takeProfit >= inputs.entryPrice) {
    const m = "Take profit must be below entry for a SELL.";
    blockers.push(m);
    reasons.push({ code: "TP_WRONG_SIDE", severity: "BLOCK", message: m });
  }

  // Risk vs balance
  if (inputs.accountBalance > 0) {
    const riskPct = (estimatedRisk / inputs.accountBalance) * 100;
    if (riskPct > inputs.maxRiskPerTradePct) {
      const m = `Estimated risk $${estimatedRisk.toFixed(2)} (${riskPct.toFixed(2)}%) exceeds your max per-trade limit of ${inputs.maxRiskPerTradePct}%.`;
      blockers.push(m);
      reasons.push({ code: "RISK_OVER_LIMIT", severity: "BLOCK", message: m });
    } else if (riskPct > inputs.maxRiskPerTradePct * 0.8) {
      const m = `Estimated risk is ${riskPct.toFixed(2)}% — close to your ${inputs.maxRiskPerTradePct}% per-trade limit.`;
      warnings.push(m);
      reasons.push({ code: "RISK_NEAR_LIMIT", severity: "WARN", message: m });
    }
  }

  // Spread check
  if (inputs.spreadPips !== null && inputs.spreadPips > inputs.maxAcceptableSpreadPips) {
    const m = `Spread ${inputs.spreadPips} pips exceeds the acceptable limit of ${inputs.maxAcceptableSpreadPips} pips.`;
    blockers.push(m);
    reasons.push({ code: "SPREAD_TOO_WIDE", severity: "BLOCK", message: m });
  }

  // ── Warnings (non-blocking) ────────────────────────────────────────────
  if (inputs.permissionStatus === "CAUTION") {
    const detail = inputs.permissionBlockers[0] ?? "review Risk Center before proceeding";
    const m = `Permission CAUTION — ${detail}.`;
    warnings.push(m);
    reasons.push({ code: "PERMISSION_CAUTION", severity: "WARN", message: m });
  }

  if (rewardToRisk > 0 && rewardToRisk < 1) {
    const m = `Reward-to-risk is ${rewardToRisk.toFixed(2)} — below 1.0; the trade risks more than it can earn.`;
    warnings.push(m);
    reasons.push({ code: "POOR_RR", severity: "WARN", message: m });
  }

  if (
    typeof inputs.aiConfidence === "number" &&
    typeof inputs.minConfidence === "number" &&
    inputs.aiConfidence < inputs.minConfidence
  ) {
    const m = `AI confidence ${inputs.aiConfidence.toFixed(0)} is below your minimum (${inputs.minConfidence}).`;
    warnings.push(m);
    reasons.push({ code: "LOW_CONFIDENCE", severity: "WARN", message: m });
  }

  const verdict = blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "WARN" : "APPROVED";

  return {
    verdict,
    estimatedRisk,
    rewardToRisk,
    pricedSlDistance: slDistance,
    pricedTpDistance: tpDistance,
    reasons,
    warnings,
    blockers,
  };
}
