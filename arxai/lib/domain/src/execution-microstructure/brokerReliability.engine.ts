import {
  type BrokerId, type BrokerReliability, clamp01, clampNonNegative,
} from "./executionMicrostructure.types";

// ═══════════════════════════════════════════════════════════════════════════
// Broker Reliability — composite [0,1] from recent rejects, requotes,
// average latency. Hard blocks if rejects/requotes exceed thresholds.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ReliabilityInput {
  brokerId: BrokerId;
  recentRejects: number;
  recentRequotes: number;
  recentTotalOrders: number;
  recentLatencyMs: number;
  hardRejectRate?: number;        // default 0.10
  hardRequoteRate?: number;       // default 0.20
  latencyHardCapMs?: number;      // default 1500
}

export function assessBrokerReliability(input: ReliabilityInput): BrokerReliability {
  const reasons: string[] = []; const blockers: string[] = [];
  const total = Math.max(1, input.recentTotalOrders);
  const rejRate = clamp01(input.recentRejects / total);
  const reqRate = clamp01(input.recentRequotes / total);
  const latency = clampNonNegative(input.recentLatencyMs);
  const hardR = input.hardRejectRate ?? 0.10;
  const hardQ = input.hardRequoteRate ?? 0.20;
  const hardL = input.latencyHardCapMs ?? 1500;

  const rejPenalty = clamp01(rejRate / hardR);
  const reqPenalty = clamp01(reqRate / hardQ);
  const latPenalty = clamp01(latency / hardL);
  const reliability01 = clamp01(1 - (0.5 * rejPenalty + 0.3 * reqPenalty + 0.2 * latPenalty));
  reasons.push(`reject ${(rejRate*100).toFixed(1)}% · requote ${(reqRate*100).toFixed(1)}% · latency ${latency.toFixed(0)}ms → reliability ${reliability01.toFixed(2)}`);

  if (rejRate >= hardR) blockers.push(`reject rate ${(rejRate*100).toFixed(1)}% ≥ hard cap ${(hardR*100).toFixed(0)}%`);
  if (reqRate >= hardQ) blockers.push(`requote rate ${(reqRate*100).toFixed(1)}% ≥ hard cap ${(hardQ*100).toFixed(0)}%`);
  if (latency >= hardL) blockers.push(`latency ${latency.toFixed(0)}ms ≥ hard cap ${hardL}ms`);

  return {
    brokerId: input.brokerId, reliability01,
    recentRejectsRate01: rejRate, recentRequotesRate01: reqRate, recentLatencyMs: latency,
    reasons, blockers,
  };
}
