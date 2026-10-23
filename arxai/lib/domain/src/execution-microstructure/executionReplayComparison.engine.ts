// ═══════════════════════════════════════════════════════════════════════════
// Execution Replay Comparison — Phase 4
//
// Compares an ExecutionConditionSnapshot (captured AT decision time) against
// an ActualFill (captured AFTER the broker reports back), and produces an
// ExecutionReplayComparison that the Black Box Vault can store for replay,
// drift detection, and post-mortem analysis.
//
// Pure. Never throws. Inputs are assumed to have already passed Zod parsing
// at the route boundary.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type ExecutionConditionSnapshot,
  type ActualFill,
  type ExecutionReplayComparison,
  type FillDeviation,
  clamp01,
} from "./executionMicrostructure.types";

const PIP_DIVISOR = 0.0001; // synthetic-vol-style; consumers can rescale

function pipsBetween(actualPrice: number, expectedPrice: number, side: "BUY" | "SELL"): number {
  // Slippage is "worse than expected" when fill is higher for BUY or lower
  // for SELL. Sign convention: positive = trader paid more than expected.
  const raw = actualPrice - expectedPrice;
  const signed = side === "BUY" ? raw : -raw;
  return signed / PIP_DIVISOR;
}

export interface ReplayComparisonInput {
  snapshot: ExecutionConditionSnapshot;
  actual: ActualFill;
  // Optional: actual realised quality (from a post-trade quality engine).
  // If omitted we estimate it from fill ratio + slippage.
  actualQualityScore01?: number;
}

export function compareExpectedVsActualFill(
  input: ReplayComparisonInput,
): ExecutionReplayComparison {
  const { snapshot, actual } = input;
  const reasons: string[] = [];
  const anomalies: string[] = [];

  // 1. Slippage delta (actual − expected, in pips, signed against trader).
  const actualSlippagePips = pipsBetween(actual.fillPrice, snapshot.expectedFill.fillPrice, snapshot.side);
  const slippageDeltaPips = actualSlippagePips - snapshot.expectedFill.expectedSlippagePips;
  reasons.push(
    `slippage actual ${actualSlippagePips.toFixed(2)}p vs expected ${snapshot.expectedFill.expectedSlippagePips.toFixed(2)}p → Δ ${slippageDeltaPips.toFixed(2)}p`,
  );

  // 2. Latency delta (fill − decision).
  const latencyDeltaMs = actual.fillLatencyMs - snapshot.latencyAtDecisionMs;
  reasons.push(
    `latency fill ${actual.fillLatencyMs.toFixed(0)}ms vs decision ${snapshot.latencyAtDecisionMs.toFixed(0)}ms → Δ ${latencyDeltaMs.toFixed(0)}ms`,
  );

  // 3. Fill ratio (filledLots / intendedLots).
  const fillRatio01 = clamp01(actual.intendedLots > 0 ? actual.filledLots / actual.intendedLots : 0);
  reasons.push(`filled ${actual.filledLots.toFixed(2)} / ${actual.intendedLots.toFixed(2)} = ${(fillRatio01 * 100).toFixed(0)}%`);

  // 4. Quality delta. Use estimated quality if not supplied.
  const estActualQuality = clamp01(
    fillRatio01 * 0.6 +
    Math.max(0, 1 - Math.abs(slippageDeltaPips) / 10) * 0.3 +
    (actual.rejected || actual.requoted ? 0 : 1) * 0.1,
  );
  const actualQuality01 = input.actualQualityScore01 ?? estActualQuality;
  const qualityDelta01 = actualQuality01 - snapshot.expectedFill.qualityScore01;
  reasons.push(`quality actual ${actualQuality01.toFixed(2)} vs expected ${snapshot.expectedFill.qualityScore01.toFixed(2)} → Δ ${qualityDelta01.toFixed(2)}`);

  // 5. Anomaly classification.
  if (actual.rejected) anomalies.push(`order REJECTED by broker`);
  if (actual.requoted) anomalies.push(`order REQUOTED by broker`);
  if (fillRatio01 === 0 && !actual.rejected) anomalies.push(`zero fill (no rejection reported)`);
  if (fillRatio01 < 1 && fillRatio01 > 0) anomalies.push(`partial fill ${(fillRatio01 * 100).toFixed(0)}%`);
  if (slippageDeltaPips > 5) anomalies.push(`slippage exceeded expectation by ${slippageDeltaPips.toFixed(1)}p`);
  if (latencyDeltaMs > 1000) anomalies.push(`fill latency exceeded decision latency by ${latencyDeltaMs.toFixed(0)}ms`);
  if (snapshot.brokerHealthStatus === "OUTAGE") anomalies.push(`broker health was OUTAGE at decision time`);

  // 6. Severity bands.
  let deviation: FillDeviation = "NONE";
  if (
    actual.rejected ||
    fillRatio01 === 0 ||
    Math.abs(slippageDeltaPips) > 10 ||
    Math.abs(qualityDelta01) > 0.40
  ) {
    deviation = "SEVERE";
  } else if (
    actual.requoted ||
    fillRatio01 < 0.5 ||
    Math.abs(slippageDeltaPips) > 5 ||
    latencyDeltaMs > 1000 ||
    Math.abs(qualityDelta01) > 0.20
  ) {
    deviation = "MAJOR";
  } else if (
    fillRatio01 < 1 ||
    Math.abs(slippageDeltaPips) > 1 ||
    latencyDeltaMs > 250 ||
    Math.abs(qualityDelta01) > 0.05
  ) {
    deviation = "MINOR";
  }
  reasons.push(`deviation ${deviation}`);

  return {
    decisionId: snapshot.decisionId,
    slippageDeltaPips, latencyDeltaMs, fillRatio01, qualityDelta01,
    deviation, reasons, anomalies,
  };
}

// ─── Broker health classifier (used by the snapshot builder) ─────────────
export function classifyBrokerHealth(reliability01: number, rejectsRate01: number): {
  status: "HEALTHY" | "DEGRADED" | "UNSTABLE" | "OUTAGE";
} {
  if (rejectsRate01 >= 0.50 || reliability01 <= 0.10) return { status: "OUTAGE" };
  if (rejectsRate01 >= 0.20 || reliability01 < 0.40) return { status: "UNSTABLE" };
  if (rejectsRate01 >= 0.05 || reliability01 < 0.70) return { status: "DEGRADED" };
  return { status: "HEALTHY" };
}
