// ═══════════════════════════════════════════════════════════════════════════
// Judge Replay
//
// Replays the judge verdict and grades it against the simulated outcome.
//   • verdictCorrect — APPROVE matched a winning direction, BLOCK matched
//                      a losing direction, DEFER neutral
//   • blockMissedOpportunity — BLOCK on a setup that would have won
//   • approveBacked   — APPROVE on a setup that did win
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { JudgeVerdict, TradeOutcome } from "./replay.types";

export const JudgeReplayReportSchema = z.object({
  decision: z.enum(["APPROVE","BLOCK","DEFER"]),
  agreementScore01: z.number().min(0).max(1),
  verdictCorrect: z.boolean(),
  blockMissedOpportunity: z.boolean(),
  approveBacked: z.boolean(),
  notes: z.array(z.string()),
});
export type JudgeReplayReport = z.infer<typeof JudgeReplayReportSchema>;

export function replayJudge(verdict: JudgeVerdict | null, outcome: TradeOutcome): JudgeReplayReport {
  if (!verdict) {
    return { decision: "DEFER", agreementScore01: 0,
      verdictCorrect: true, blockMissedOpportunity: false, approveBacked: false,
      notes: ["no judge verdict on snapshot"] };
  }
  const win  = outcome.status === "CLOSED_WIN" || outcome.status === "TARGET_HIT";
  const loss = outcome.status === "CLOSED_LOSS" || outcome.status === "STOPPED_OUT";
  const verdictCorrect =
    (verdict.decision === "APPROVE" && win) ||
    (verdict.decision === "BLOCK"   && loss) ||
    (verdict.decision === "DEFER"   && !win && !loss);
  return {
    decision: verdict.decision,
    agreementScore01: verdict.agreementScore01,
    verdictCorrect,
    blockMissedOpportunity: verdict.decision === "BLOCK" && win,
    approveBacked:          verdict.decision === "APPROVE" && win,
    notes: verdict.blockReasons.slice(0, 5),
  };
}
