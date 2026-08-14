import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

const MAX_AVG_LATENCY_MS    = 600;
const MAX_AVG_SLIPPAGE_PIPS = 1.5;

export function scoreExecutionQuality(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const broker = ctx.broker;

  if (!broker.health.isHealthy) {
    blockers.push(`Broker unhealthy: ${broker.health.reasons.join("; ") || "unknown"}`);
  }
  if (broker.health.isStale) {
    blockers.push(`Broker connection stale (age ${broker.health.ageSeconds ?? "?"}s)`);
  }

  const exec = broker.execution;
  if (!exec) {
    warnings.push("No execution-quality samples — defaulting to 7/10");
    return finalize(7, warnings, blockers, "No samples → conservative default 7/10");
  }

  // Quality (0..4)
  const qScore = Math.round((Math.max(0, Math.min(100, exec.qualityScore)) / 100) * 4);
  if (exec.qualityScore < 60) blockers.push(`Broker quality ${exec.qualityScore.toFixed(0)} <60`);

  // Latency (0..3)
  let latScore = 3;
  if (exec.avgLatencyMs > MAX_AVG_LATENCY_MS) {
    latScore = 0;
    blockers.push(`Latency ${exec.avgLatencyMs.toFixed(0)}ms >${MAX_AVG_LATENCY_MS}ms`);
  } else {
    latScore = Math.max(0, Math.round(3 * (1 - exec.avgLatencyMs / MAX_AVG_LATENCY_MS)));
    if (exec.avgLatencyMs > MAX_AVG_LATENCY_MS * 0.6) warnings.push("Latency elevated");
  }

  // Slippage (0..3)
  const slip = Math.abs(exec.avgSlippagePips ?? 0);
  let slipScore = 3;
  if (slip > MAX_AVG_SLIPPAGE_PIPS) {
    slipScore = 0;
    blockers.push(`Slippage ${slip.toFixed(2)}p >${MAX_AVG_SLIPPAGE_PIPS}p`);
  } else {
    slipScore = Math.max(0, Math.round(3 * (1 - slip / MAX_AVG_SLIPPAGE_PIPS)));
  }

  const score = Math.max(0, Math.min(10, qScore + latScore + slipScore));

  return finalize(
    score, warnings, blockers,
    `Quality ${exec.qualityScore.toFixed(0)} (${qScore}/4), latency ${exec.avgLatencyMs.toFixed(0)}ms (${latScore}/3), slippage ${slip.toFixed(2)}p (${slipScore}/3) — ${score}/10`,
  );
}

function finalize(
  score: number, warnings: string[], blockers: string[], explanation: string,
): PyramidScoreReport {
  return {
    category: "executionQuality",
    score, warnings, blockers, explanation,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
