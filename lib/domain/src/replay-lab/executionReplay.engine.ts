// ═══════════════════════════════════════════════════════════════════════════
// Execution Replay
//
// Quantifies execution friction recorded on the snapshot:
//   • slippage cost vs intended entry
//   • partial fill ratio
//   • broker reject indicator
//   • latency penalty
// Returns an executionQuality01 score and a list of friction notes.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ExecutionConditions, TradeIntent } from "./replay.types";

export const ExecutionReplayReportSchema = z.object({
  fillRatio: z.number().min(0).max(1),
  slippagePips: z.number(),
  latencyMs: z.number().nonnegative(),
  partialFill: z.boolean(),
  brokerReject: z.boolean(),
  executionQuality01: z.number().min(0).max(1),
  notes: z.array(z.string()),
});
export type ExecutionReplayReport = z.infer<typeof ExecutionReplayReportSchema>;

export function replayExecution(
  exec: ExecutionConditions | null, intent: TradeIntent | null,
): ExecutionReplayReport {
  if (!exec || !intent) {
    return { fillRatio: 1, slippagePips: 0, latencyMs: 0,
      partialFill: false, brokerReject: false,
      executionQuality01: 1, notes: ["no execution conditions on snapshot"] };
  }
  const fillRatio = exec.requestedLotSize > 0 ? Math.min(1, exec.filledLotSize / exec.requestedLotSize) : 1;
  const slipPenalty   = clamp01(Math.abs(exec.slippagePips) / 5);   // 5 pips → full penalty
  const latencyPenalty = clamp01(exec.latencyMs / 2000);            // 2s → full penalty
  const partialPenalty = exec.partialFill ? 0.3 : 0;
  const rejectPenalty  = exec.brokerReject ? 0.5 : 0;
  const fillPenalty    = 1 - fillRatio;
  const quality = clamp01(1 - (slipPenalty * 0.3 + latencyPenalty * 0.2 + partialPenalty + rejectPenalty + fillPenalty * 0.4));
  const notes: string[] = [];
  if (Math.abs(exec.slippagePips) > 1) notes.push(`slippage ${exec.slippagePips} pips`);
  if (exec.latencyMs > 500) notes.push(`latency ${exec.latencyMs}ms`);
  if (exec.partialFill) notes.push("partial fill");
  if (exec.brokerReject) notes.push("broker reject");
  if (fillRatio < 1) notes.push(`fill ratio ${round2(fillRatio)}`);
  return { fillRatio: round2(fillRatio),
    slippagePips: exec.slippagePips, latencyMs: exec.latencyMs,
    partialFill: exec.partialFill, brokerReject: exec.brokerReject,
    executionQuality01: round2(quality), notes };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
