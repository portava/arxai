import {
  type PipelineDecision, type PipelineStage, type StagePerformance, type StagePromotionCriteria,
  DEFAULT_PIPELINE_CRITERIA, PIPELINE_DEMOTION, PIPELINE_STAGE_ORDER, pipelineStageIndex,
} from "./pipelineStages.types";

// evaluateStagePromotion — given current stage + perf, decide PROMOTE /
// HOLD / DEMOTE / RETIRE. Demotion + retire evaluated BEFORE promotion
// (risk preservation). RETIRE is a one-way terminal state (catastrophic
// underperformance).
export function evaluateStagePromotion(
  strategyId: string,
  currentStage: PipelineStage,
  perf: StagePerformance,
  criteriaByStage: Record<PipelineStage, StagePromotionCriteria> = DEFAULT_PIPELINE_CRITERIA,
): PipelineDecision {
  const D = PIPELINE_DEMOTION;
  const idx = pipelineStageIndex(currentStage);
  const reasons: string[] = [];

  // ── RETIRE check (catastrophic) ─────────────────────────────────────
  if (perf.sampleCount >= D.retireMinSamples && perf.expectancyR <= D.retireExpectancyR) {
    const reason = `RETIRE — expectancy ${perf.expectancyR.toFixed(2)}R ≤ ${D.retireExpectancyR}R over ${perf.sampleCount} samples`;
    return {
      kind: "RETIRE", strategyId, fromStage: currentStage, toStage: currentStage,
      failedGates: [reason], reasons: [reason],
    };
  }

  // ── DEMOTE check ────────────────────────────────────────────────────
  const cur = criteriaByStage[currentStage];
  const severeDrawdown = perf.maxDrawdownPct >= cur.maxDrawdownPct * D.drawdownSevereMultiplier;
  const sustainedNegEx = perf.expectancyR < D.expectancyFloorR && perf.sampleCount >= D.minDemotionSamples;
  if (severeDrawdown || sustainedNegEx) {
    const failedGates: string[] = [];
    if (severeDrawdown) failedGates.push(`SEVERE_DRAWDOWN ${perf.maxDrawdownPct.toFixed(1)}% ≥ ${(cur.maxDrawdownPct * D.drawdownSevereMultiplier).toFixed(1)}%`);
    if (sustainedNegEx) failedGates.push(`NEGATIVE_EXPECTANCY ${perf.expectancyR.toFixed(2)}R < ${D.expectancyFloorR}R over ${perf.sampleCount} samples`);
    if (idx === 0) {
      reasons.push(...failedGates, `→ HOLD at ${currentStage} — demotion triggered but already at first stage`);
      return { kind: "HOLD", strategyId, fromStage: currentStage, toStage: currentStage, failedGates, reasons };
    }
    const toStage = PIPELINE_STAGE_ORDER[idx - 1]!;
    reasons.push(...failedGates, `→ DEMOTE ${currentStage} → ${toStage}`);
    return { kind: "DEMOTE", strategyId, fromStage: currentStage, toStage, failedGates, reasons };
  }

  // ── Already at top → HOLD ───────────────────────────────────────────
  if (idx === PIPELINE_STAGE_ORDER.length - 1) {
    return { kind: "HOLD", strategyId, fromStage: currentStage, toStage: currentStage,
      failedGates: [], reasons: [`already at FULL_APPROVAL — cannot promote further`] };
  }

  // ── Promotion gate check ────────────────────────────────────────────
  const nextStage = PIPELINE_STAGE_ORDER[idx + 1]!;
  const next = criteriaByStage[nextStage];
  const failedGates: string[] = [];
  if (perf.sampleCount   < next.minSampleCount)  failedGates.push(`SAMPLE_COUNT ${perf.sampleCount} < ${next.minSampleCount}`);
  if (perf.expectancyR   < next.minExpectancyR)  failedGates.push(`EXPECTANCY ${perf.expectancyR.toFixed(2)}R < ${next.minExpectancyR}R`);
  if (perf.maxDrawdownPct > next.maxDrawdownPct) failedGates.push(`DRAWDOWN ${perf.maxDrawdownPct.toFixed(1)}% > ${next.maxDrawdownPct}%`);
  if (perf.winRate01     < next.minWinRate01)    failedGates.push(`WIN_RATE ${(perf.winRate01 * 100).toFixed(1)}% < ${(next.minWinRate01 * 100).toFixed(1)}%`);
  if (perf.sharpeRatio   < next.minSharpeRatio)  failedGates.push(`SHARPE ${perf.sharpeRatio.toFixed(2)} < ${next.minSharpeRatio}`);

  if (failedGates.length === 0) {
    reasons.push(`all gates passed → PROMOTE ${currentStage} → ${nextStage}`);
    return { kind: "PROMOTE", strategyId, fromStage: currentStage, toStage: nextStage, failedGates: [], reasons };
  }
  reasons.push(`${failedGates.length} gate(s) failed — HOLD at ${currentStage}`, ...failedGates);
  return { kind: "HOLD", strategyId, fromStage: currentStage, toStage: currentStage, failedGates, reasons };
}
