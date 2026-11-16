import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";

// Execution quality blockers are SEVERITY=BROKER — they cannot be overridden
// by AI or risk because the trade physically cannot be reliably placed.
const MAX_AVG_LATENCY_MS = 600;
const MAX_AVG_SLIPPAGE_PIPS = 1.5;
const MIN_QUALITY_SCORE = 60;

export function scoreExecutionQuality(ctx: ConfidenceGateContext): ScoreReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];

  const broker = ctx.broker;

  // Connection / staleness — absolute blockers
  if (!broker.health.isHealthy) {
    blockers.push({ severity: "BROKER", dimension: "executionQuality",
      message: `Broker unhealthy: ${broker.health.reasons.join("; ") || "unknown"}` });
  }
  if (broker.health.isStale) {
    blockers.push({ severity: "BROKER", dimension: "executionQuality",
      message: `Broker connection stale (age ${broker.health.ageSeconds ?? "?"}s)` });
  }

  const exec = broker.execution;
  if (!exec) {
    // No samples yet — score conservatively but don't block
    warnings.push("No execution quality samples yet — using conservative defaults");
    return {
      dimension: "executionQuality",
      score: 70, weight: SCORE_WEIGHTS.executionQuality,
      blockers, warnings,
      reasons: ["No execution samples → default 70/100"],
      evidence: { brokerHealth: broker.health },
    };
  }

  // 1. Quality score (0..40) — direct reflection of broker's own metric
  const qScore = Math.round((Math.max(0, Math.min(100, exec.qualityScore)) / 100) * 40);
  if (exec.qualityScore < MIN_QUALITY_SCORE) {
    blockers.push({ severity: "BROKER", dimension: "executionQuality",
      message: `Broker quality ${exec.qualityScore.toFixed(0)} < ${MIN_QUALITY_SCORE}` });
  }
  // 2. Latency (0..30)
  const latency = exec.avgLatencyMs;
  let latScore = 30;
  if (latency > MAX_AVG_LATENCY_MS) {
    latScore = 5;
    blockers.push({ severity: "BROKER", dimension: "executionQuality",
      message: `Avg latency ${latency.toFixed(0)}ms > ${MAX_AVG_LATENCY_MS}ms` });
  } else {
    latScore = Math.round(30 * (1 - latency / MAX_AVG_LATENCY_MS));
    if (latency > MAX_AVG_LATENCY_MS * 0.6) warnings.push(`Latency ${latency.toFixed(0)}ms is elevated`);
  }
  // 3. Slippage (0..30)
  const slip = Math.abs(exec.avgSlippagePips ?? 0);
  let slipScore = 30;
  if (slip > MAX_AVG_SLIPPAGE_PIPS) {
    slipScore = 5;
    blockers.push({ severity: "BROKER", dimension: "executionQuality",
      message: `Avg slippage ${slip.toFixed(2)} pips > ${MAX_AVG_SLIPPAGE_PIPS}` });
  } else {
    slipScore = Math.round(30 * (1 - slip / MAX_AVG_SLIPPAGE_PIPS));
  }

  const score = Math.round(qScore + latScore + slipScore);

  reasons.push(`Quality ${exec.qualityScore.toFixed(0)} → ${qScore}/40`);
  reasons.push(`Latency ${latency.toFixed(0)}ms → ${latScore}/30`);
  reasons.push(`Slippage ${slip.toFixed(2)}p → ${slipScore}/30`);

  return {
    dimension: "executionQuality",
    score, weight: SCORE_WEIGHTS.executionQuality,
    blockers, warnings, reasons,
    evidence: {
      brokerHealth: broker.health,
      qualityScore: exec.qualityScore,
      avgLatencyMs: exec.avgLatencyMs,
      avgSlippagePips: exec.avgSlippagePips,
      sampleCount: exec.sampleCount,
    },
  };
}
