import { z } from "zod/v4";

export const ProcessRecommendationSchema = z.enum([
  "ADD_DELIBERATION_STAGE",
  "REMOVE_DELIBERATION_STAGE",
  "TIGHTEN_QUORUM",
  "LOOSEN_QUORUM",
  "REDUCE_LATENCY",
  "KEEP",
]);
export type ProcessRecommendation = z.infer<typeof ProcessRecommendationSchema>;

export interface DecisionProcessMetrics {
  avgDeliberationMs: number;
  avgContributorsPerDecision: number;
  consensusRate01: number;              // % of decisions where contributors agreed
  overrideFrequency01: number;          // % of judge proposals overridden by governor
  expectancyR: number;                  // overall outcome quality
  sampleCount: number;
}

export interface DecisionProcessRecommendation {
  recommendation: ProcessRecommendation;
  confidence01: number;
  reasons: string[];
}

export const PROCESS_THRESHOLDS = {
  minSamples: 50,
  highLatencyMs: 500,
  highConsensusRate01: 0.85,            // too much consensus = groupthink → ADD_STAGE
  lowConsensusRate01: 0.35,             // too little consensus = noise → TIGHTEN_QUORUM
  highOverrideFreq01: 0.25,             // governor overrides judge often → ADD_STAGE
  highContributorCount: 12,             // too many cooks → REMOVE_STAGE
  lowContributorCount: 3,
} as const;

// analyzeDecisionProcess — examine the process itself rather than the
// outcomes. Suggests architectural changes when process metrics indicate
// dysfunction (groupthink, noise, latency, governor friction). Single
// recommendation returned — caller applies one change at a time.
//
// Priority order (first applicable wins, since changes interact):
//   1. governor overrides too high       → ADD_DELIBERATION_STAGE
//   2. consensus too low (noisy panel)   → TIGHTEN_QUORUM
//   3. consensus too high (groupthink)   → ADD_DELIBERATION_STAGE (different perspective)
//   4. too many contributors             → REMOVE_DELIBERATION_STAGE
//   5. too few contributors              → LOOSEN_QUORUM
//   6. high latency                      → REDUCE_LATENCY
//   7. else                              → KEEP
export function analyzeDecisionProcess(m: DecisionProcessMetrics): DecisionProcessRecommendation {
  const T = PROCESS_THRESHOLDS;
  const reasons: string[] = [];

  if (m.sampleCount < T.minSamples) {
    reasons.push(`only ${m.sampleCount} samples < ${T.minSamples} required`);
    return { recommendation: "KEEP", confidence01: 0.2, reasons };
  }

  if (m.overrideFrequency01 >= T.highOverrideFreq01) {
    reasons.push(`governor override freq ${(m.overrideFrequency01 * 100).toFixed(0)}% ≥ ${T.highOverrideFreq01 * 100}% — judge proposes too aggressively`);
    return { recommendation: "ADD_DELIBERATION_STAGE", confidence01: 0.7, reasons };
  }
  if (m.consensusRate01 <= T.lowConsensusRate01) {
    reasons.push(`consensus rate ${(m.consensusRate01 * 100).toFixed(0)}% ≤ ${T.lowConsensusRate01 * 100}% — noisy panel`);
    return { recommendation: "TIGHTEN_QUORUM", confidence01: 0.6, reasons };
  }
  if (m.consensusRate01 >= T.highConsensusRate01) {
    reasons.push(`consensus rate ${(m.consensusRate01 * 100).toFixed(0)}% ≥ ${T.highConsensusRate01 * 100}% — possible groupthink`);
    return { recommendation: "ADD_DELIBERATION_STAGE", confidence01: 0.55, reasons };
  }
  if (m.avgContributorsPerDecision >= T.highContributorCount) {
    reasons.push(`avg contributors ${m.avgContributorsPerDecision.toFixed(1)} ≥ ${T.highContributorCount} — diminishing returns`);
    return { recommendation: "REMOVE_DELIBERATION_STAGE", confidence01: 0.55, reasons };
  }
  if (m.avgContributorsPerDecision <= T.lowContributorCount) {
    reasons.push(`avg contributors ${m.avgContributorsPerDecision.toFixed(1)} ≤ ${T.lowContributorCount} — quorum may be too tight`);
    return { recommendation: "LOOSEN_QUORUM", confidence01: 0.5, reasons };
  }
  if (m.avgDeliberationMs >= T.highLatencyMs) {
    reasons.push(`avg deliberation ${m.avgDeliberationMs.toFixed(0)}ms ≥ ${T.highLatencyMs}ms — too slow`);
    return { recommendation: "REDUCE_LATENCY", confidence01: 0.6, reasons };
  }
  reasons.push("process metrics within healthy ranges — KEEP");
  return { recommendation: "KEEP", confidence01: 0.7, reasons };
}
