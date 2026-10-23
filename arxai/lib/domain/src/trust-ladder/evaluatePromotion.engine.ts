import {
  type PromotionCriteria, type PromotionDecision, type PromotionMetricsSnapshot,
  type TrustRung, DEFAULT_PROMOTION_CRITERIA, DEMOTION_THRESHOLDS, TRUST_RUNG_ORDER, rungIndex,
} from "./trustLadder.types";

// evaluatePromotion — given the current rung + a fresh metrics snapshot,
// decide PROMOTE / HOLD / DEMOTE.
//
// Six promotion gates (ALL must pass to advance):
//   1. minSampleCount        — enough graded data
//   2. minExpectancyR        — positive expected value per trade
//   3. maxDrawdownPct        — within drawdown ceiling
//   4. maxCalibrationErrorPct — confidence well-calibrated
//   5. maxExecutionErrorRate01 — clean fills
//   6. minRiskComplianceScore01 — strong rule adherence
//
// Demotion (one rung down) fires when:
//   • drawdown ≥ current rung's maxDrawdownPct × severe multiplier, OR
//   • expectancyR < demotionExpectancyFloor AND sampleCount ≥ minDemotionSamples
// Both conditions are independent — either alone triggers DEMOTE.
//
// Already at top rung + all gates pass → HOLD (cannot promote further).
// Already at bottom rung + demotion triggered → HOLD (already as restricted as possible).
export function evaluatePromotion(
  currentRung: TrustRung,
  snapshot: PromotionMetricsSnapshot,
  criteriaByRung: Record<TrustRung, PromotionCriteria> = DEFAULT_PROMOTION_CRITERIA,
): PromotionDecision {
  const reasons: string[] = [];
  const idx = rungIndex(currentRung);

  // ── Demotion check first — risk preservation takes priority ──────────
  const currentCriteria = criteriaByRung[currentRung];
  const severeDrawdown = snapshot.maxDrawdownPct >= currentCriteria.maxDrawdownPct * DEMOTION_THRESHOLDS.drawdownSevereMultiplier;
  const sustainedNegEx = snapshot.expectancyR < DEMOTION_THRESHOLDS.demotionExpectancyFloor
    && snapshot.sampleCount >= DEMOTION_THRESHOLDS.minDemotionSamples;

  if (severeDrawdown || sustainedNegEx) {
    const failedGates: string[] = [];
    if (severeDrawdown) failedGates.push(`SEVERE_DRAWDOWN ${snapshot.maxDrawdownPct.toFixed(1)}% ≥ ${(currentCriteria.maxDrawdownPct * DEMOTION_THRESHOLDS.drawdownSevereMultiplier).toFixed(1)}%`);
    if (sustainedNegEx)  failedGates.push(`NEGATIVE_EXPECTANCY ${snapshot.expectancyR.toFixed(2)}R < ${DEMOTION_THRESHOLDS.demotionExpectancyFloor}R over ${snapshot.sampleCount} samples`);
    // Already at the bottom rung — cannot demote further. HOLD with the
    // demotion reasons preserved so the audit log still records the trigger.
    if (idx === 0) {
      reasons.push(...failedGates, `→ HOLD at ${currentRung} — demotion triggered but already at bottom rung`);
      return { kind: "HOLD", fromRung: currentRung, toRung: currentRung, failedGates, reasons };
    }
    const toRung = TRUST_RUNG_ORDER[idx - 1]!;
    reasons.push(...failedGates, `→ DEMOTE ${currentRung} → ${toRung}`);
    return { kind: "DEMOTE", fromRung: currentRung, toRung, failedGates, reasons };
  }

  // ── Already at top → HOLD ────────────────────────────────────────────
  if (idx === TRUST_RUNG_ORDER.length - 1) {
    return {
      kind: "HOLD", fromRung: currentRung, toRung: currentRung, failedGates: [],
      reasons: [`already at top rung ${currentRung} — cannot promote further`],
    };
  }

  // ── Promotion gate check ─────────────────────────────────────────────
  const nextRung = TRUST_RUNG_ORDER[idx + 1]!;
  const next = criteriaByRung[nextRung];
  const failedGates: string[] = [];

  if (snapshot.sampleCount < next.minSampleCount) {
    failedGates.push(`SAMPLE_COUNT ${snapshot.sampleCount} < ${next.minSampleCount}`);
  }
  if (snapshot.expectancyR < next.minExpectancyR) {
    failedGates.push(`EXPECTANCY ${snapshot.expectancyR.toFixed(2)}R < ${next.minExpectancyR}R`);
  }
  if (snapshot.maxDrawdownPct > next.maxDrawdownPct) {
    failedGates.push(`DRAWDOWN ${snapshot.maxDrawdownPct.toFixed(1)}% > ${next.maxDrawdownPct}%`);
  }
  if (snapshot.meanCalibrationErrorPct > next.maxCalibrationErrorPct) {
    failedGates.push(`CALIBRATION_ERROR ${snapshot.meanCalibrationErrorPct.toFixed(1)}pp > ${next.maxCalibrationErrorPct}pp`);
  }
  if (snapshot.executionErrorRate01 > next.maxExecutionErrorRate01) {
    failedGates.push(`EXECUTION_ERROR ${(snapshot.executionErrorRate01 * 100).toFixed(1)}% > ${(next.maxExecutionErrorRate01 * 100).toFixed(1)}%`);
  }
  if (snapshot.riskComplianceScore01 < next.minRiskComplianceScore01) {
    failedGates.push(`RISK_COMPLIANCE ${(snapshot.riskComplianceScore01 * 100).toFixed(1)}% < ${(next.minRiskComplianceScore01 * 100).toFixed(1)}%`);
  }

  if (failedGates.length === 0) {
    reasons.push(`all 6 promotion gates passed → PROMOTE ${currentRung} → ${nextRung}`);
    return { kind: "PROMOTE", fromRung: currentRung, toRung: nextRung, failedGates: [], reasons };
  }
  reasons.push(`${failedGates.length} promotion gate(s) failed — HOLD at ${currentRung}`, ...failedGates);
  return { kind: "HOLD", fromRung: currentRung, toRung: currentRung, failedGates, reasons };
}
