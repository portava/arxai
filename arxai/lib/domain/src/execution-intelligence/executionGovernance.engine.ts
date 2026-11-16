// ═══════════════════════════════════════════════════════════════════════════
// Execution Governance — derives the two Phase 4 outputs that other safety
// engines must consume:
//
//   executionRiskScore : number 0..1   →  Risk Governor
//   executionHealth    : "HEALTHY" | "DEGRADED" | "UNSTABLE" | "LOCKDOWN"
//                                      →  Control Tower
//
// These are derivations, not new state. They turn the rich PreTrade /
// PostTrade / BrokerScorecard outputs into single, named scalars that the
// rest of the safety stack (Risk Governor's `executionRisk01` input,
// Control Tower's `executionRiskHigh` input via driveGlobalState) can
// consume directly without needing to understand TCA internals.
//
// SAFETY: pure functions; no side-effects; cannot place trades.
//
// PRODUCER → CONSUMER wiring (caller-orchestrated, by design):
//   Producer field            →  Consumer slot (already exists in safetyCore)
//   executionRiskScore.score01 →  tradeGate({ executionRisk01 })
//   executionHealth.executionRiskHigh →  driveGlobalState({ executionRiskHigh })
// The orchestration layer (e.g. brain/agents) is responsible for the
// forwarding. We do NOT couple execution-intel directly to tradeGate /
// driveGlobalState — that would violate the "advisory only" boundary.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import {
  type PreTradeCostEstimate,
  type PostTradeExecutionReport,
  type BrokerScorecard,
  clamp01,
} from "./executionIntelligence.types";

export const ExecutionHealthStatusSchema = z.enum([
  "HEALTHY", "DEGRADED", "UNSTABLE", "LOCKDOWN",
]);
export type ExecutionHealthStatus = z.infer<typeof ExecutionHealthStatusSchema>;

export const ExecutionRiskScoreSchema = z.object({
  score01: z.number().min(0).max(1),
  band: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  reasons: z.array(z.string()),
});
export type ExecutionRiskScore = z.infer<typeof ExecutionRiskScoreSchema>;

export const ExecutionHealthSchema = z.object({
  status: ExecutionHealthStatusSchema,
  /** Convenience flag for Control Tower's `executionRiskHigh` input. */
  executionRiskHigh: z.boolean(),
  reliability01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type ExecutionHealth = z.infer<typeof ExecutionHealthSchema>;

// ── deriveExecutionRiskScore (pre-trade or post-trade) ───────────────────
// Maps the verdict + cost-vs-edge ratio + grade into a single 0..1 risk
// scalar. Risk Governor consumes it via tradeGate's `executionRisk01`.
export function deriveExecutionRiskScoreFromPreTrade(
  est: PreTradeCostEstimate,
  expectedEdgePips: number,
): ExecutionRiskScore {
  const reasons: string[] = [];
  let s = 0;
  if (est.edgeDestroyed) { s = Math.max(s, 0.95); reasons.push("edge destroyed by expected cost"); }
  const costRatio = expectedEdgePips > 0
    ? clamp01(est.expectedCost.totalCostPips / expectedEdgePips) : 1;
  s = Math.max(s, 0.4 * costRatio + 0.4 * (1 - est.recommendedSizeMultiplier));
  switch (est.verdict) {
    case "EXECUTION_BLOCKED":   s = Math.max(s, 1.0); reasons.push("verdict EXECUTION_BLOCKED"); break;
    case "EXECUTION_UNSTABLE":  s = Math.max(s, 0.85); reasons.push("verdict EXECUTION_UNSTABLE"); break;
    case "EXECUTION_COSTLY":    s = Math.max(s, 0.65); reasons.push("verdict EXECUTION_COSTLY"); break;
    case "EXECUTION_ACCEPTABLE":s = Math.max(s, 0.30); break;
    case "EXECUTION_CLEAN":     s = Math.max(s, 0.10); break;
  }
  if (est.blockers.length > 0) reasons.push(`${est.blockers.length} blocker(s)`);
  const score01 = clamp01(s);
  return { score01, band: bandFor(score01), reasons };
}

export function deriveExecutionRiskScoreFromPostTrade(r: PostTradeExecutionReport): ExecutionRiskScore {
  const reasons: string[] = [];
  let s = 0;
  switch (r.verdict) {
    case "EXECUTION_BLOCKED":   s = 1.0;  reasons.push("post-trade verdict EXECUTION_BLOCKED"); break;
    case "EXECUTION_UNSTABLE":  s = 0.85; reasons.push("post-trade verdict EXECUTION_UNSTABLE"); break;
    case "EXECUTION_COSTLY":    s = 0.65; reasons.push("post-trade verdict EXECUTION_COSTLY"); break;
    case "EXECUTION_ACCEPTABLE":s = 0.30; break;
    case "EXECUTION_CLEAN":     s = 0.10; break;
  }
  const gradeBoost: Record<typeof r.grade, number> = { A: 0, B: 0.05, C: 0.15, D: 0.30, F: 0.50 };
  s = clamp01(s + gradeBoost[r.grade]);
  if (r.helpedOrHurt === "DESTROYED") { s = Math.max(s, 0.95); reasons.push("execution destroyed edge"); }
  if (r.anomalies.length > 0) reasons.push(`${r.anomalies.length} anomaly(ies)`);
  return { score01: s, band: bandFor(s), reasons };
}

// ── deriveExecutionHealth (broker scorecard → tower signal) ──────────────
export function deriveExecutionHealth(sc: BrokerScorecard): ExecutionHealth {
  const reasons: string[] = [...sc.reasons];
  // Control Tower forces non-trading global state when executionRiskHigh,
  // so map UNSTABLE/LOCKDOWN to that flag. DEGRADED is a softer warning
  // that should NOT yet force the tower.
  const executionRiskHigh = sc.status === "UNSTABLE" || sc.status === "LOCKDOWN";
  if (executionRiskHigh) reasons.push(`broker status ${sc.status} → executionRiskHigh`);
  return {
    status: sc.status,
    executionRiskHigh,
    reliability01: sc.reliability01,
    reasons,
  };
}

function bandFor(s: number): ExecutionRiskScore["band"] {
  if (s >= 0.85) return "CRITICAL";
  if (s >= 0.60) return "HIGH";
  if (s >= 0.30) return "MEDIUM";
  return "LOW";
}
