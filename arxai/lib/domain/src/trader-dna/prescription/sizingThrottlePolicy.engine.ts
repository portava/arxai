// ═══════════════════════════════════════════════════════════════════════════
// Sizing Throttle Policy
//
// Maps composite risk into a concrete sizing instruction:
//   • sizeMultiplier ∈ [0..1] applied on top of baseline lot
//   • microLotsOnly when severity is high
//   • capLotSize hard cap (in lots)
//
// Pure. No I/O. The Risk Governor consumes sizeMultiplier; the Control
// Tower may also enforce capLotSize directly.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const SizingThrottleSchema = z.object({
  sizeMultiplier: z.number().min(0).max(1),
  microLotsOnly: z.boolean(),
  capLotSize: z.number().nonnegative().nullable(),
  reasons: z.array(z.string()),
});
export type SizingThrottle = z.infer<typeof SizingThrottleSchema>;

export interface SizingThrottleInput {
  severity01: number;                 // 0..1 composite worst axis
  baselineLotSize: number;            // trader's personal median lot
  forceMicro?: boolean;
}

export function recommendSizingThrottle(input: SizingThrottleInput): SizingThrottle {
  const reasons: string[] = [];
  let sizeMultiplier = 1.0;
  let microLotsOnly = !!input.forceMicro;

  if (input.severity01 >= 0.85)      { sizeMultiplier = 0.0;  microLotsOnly = false; reasons.push("severity ≥0.85 → no new sizing (block)"); }
  else if (input.severity01 >= 0.65) { sizeMultiplier = 0.25; microLotsOnly = true;  reasons.push("severity ≥0.65 → micro lots only (×0.25)"); }
  else if (input.severity01 >= 0.50) { sizeMultiplier = 0.33; microLotsOnly = true;  reasons.push("severity ≥0.50 → micro lots (×0.33)"); }
  else if (input.severity01 >= 0.35) { sizeMultiplier = 0.50;                       reasons.push("severity ≥0.35 → half size"); }
  else if (input.severity01 >= 0.25) { sizeMultiplier = 0.66;                       reasons.push("severity ≥0.25 → reduced size (×0.66)"); }
  else                               { reasons.push("no sizing throttle required"); }

  if (input.forceMicro && sizeMultiplier > 0.33) {
    sizeMultiplier = 0.33; microLotsOnly = true;
    reasons.push("forceMicro switch — clamped to micro");
  }

  const capLotSize = microLotsOnly && input.baselineLotSize > 0
    ? Number((input.baselineLotSize * sizeMultiplier).toFixed(4))
    : null;

  return { sizeMultiplier, microLotsOnly, capLotSize, reasons };
}
