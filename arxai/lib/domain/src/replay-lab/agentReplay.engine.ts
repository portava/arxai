// ═══════════════════════════════════════════════════════════════════════════
// Agent Replay
//
// Replays the recorded set of agent votes and computes:
//   • per-agent accuracy vs final outcome direction
//   • aggregate calibration (Brier-like) on confidences
//   • dominant vote and dissent ratio
//
// Pure. Outcome direction is supplied (from played-back trade or recorded
// outcome) so this engine can be reused for both real and what-if runs.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { AgentVote } from "./replay.types";

export const AgentAccuracyEntrySchema = z.object({
  agentId: z.string(),
  vote: z.string(),
  confidence01: z.number().min(0).max(1),
  correct: z.boolean(),
  brier: z.number().min(0).max(1),
});
export type AgentAccuracyEntry = z.infer<typeof AgentAccuracyEntrySchema>;

export const AgentReplayReportSchema = z.object({
  sample: z.number().int().nonnegative(),
  dominantVote: z.string(),
  dissentRatio: z.number().min(0).max(1),
  averageAccuracy01: z.number().min(0).max(1),
  averageCalibration01: z.number().min(0).max(1),
  perAgent: z.array(AgentAccuracyEntrySchema),
});
export type AgentReplayReport = z.infer<typeof AgentReplayReportSchema>;

export function replayAgents(
  votes: AgentVote[],
  outcomeDirection: "BUY" | "SELL" | "NONE",
): AgentReplayReport {
  if (!votes.length) {
    return { sample: 0, dominantVote: "SKIP", dissentRatio: 0,
      averageAccuracy01: 0.5, averageCalibration01: 0.5, perAgent: [] };
  }
  const perAgent: AgentAccuracyEntry[] = votes.map(v => {
    const correct = (v.vote === outcomeDirection);
    // Brier: (confidence - actual)^2 where actual = 1 if correct else 0
    const brier = (v.confidence01 - (correct ? 1 : 0)) ** 2;
    return { agentId: v.agentId, vote: v.vote, confidence01: v.confidence01,
      correct, brier: round2(brier) };
  });
  const counts: Record<string, number> = {};
  for (const v of votes) counts[v.vote] = (counts[v.vote] ?? 0) + 1;
  const dominantVote = Object.entries(counts).sort((a,b) => b[1] - a[1])[0][0];
  const dissentRatio = (votes.length - counts[dominantVote]) / votes.length;
  const avgAcc = perAgent.filter(p => p.correct).length / perAgent.length;
  const avgBrier = perAgent.reduce((a, p) => a + p.brier, 0) / perAgent.length;
  // Calibration as 1 − meanBrier (higher = better calibrated)
  const calibration = 1 - avgBrier;
  return { sample: votes.length, dominantVote, dissentRatio: round2(dissentRatio),
    averageAccuracy01: round2(avgAcc), averageCalibration01: round2(calibration),
    perAgent };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
