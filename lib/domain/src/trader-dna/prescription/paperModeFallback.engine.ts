// ═══════════════════════════════════════════════════════════════════════════
// Paper Mode Fallback
//
// Decides whether the trader should be auto-routed to paper trading.
//   • forced=true when severity is high or trader has crossed the
//     "paper-only" threshold
//   • requiredPaperWinsToRestore: number of profitable paper trades
//     required before live permissions are restored (Recovery)
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const PaperModeFallbackSchema = z.object({
  forced: z.boolean(),
  requiredPaperWinsToRestore: z.number().int().min(0),
  minPaperWinRate: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type PaperModeFallback = z.infer<typeof PaperModeFallbackSchema>;

export interface PaperModeInput {
  severity01: number;
  baselineMature: boolean;
  ruleViolationsLast24h: number;
  forcePaperOnly?: boolean;
}

export function recommendPaperModeFallback(input: PaperModeInput): PaperModeFallback {
  const reasons: string[] = [];
  let forced = !!input.forcePaperOnly;
  let requiredPaperWinsToRestore = 0;
  let minPaperWinRate = 0;

  if (input.forcePaperOnly) reasons.push("forcePaperOnly switch active");

  if (input.severity01 >= 0.85)      { forced = true; requiredPaperWinsToRestore = 10; minPaperWinRate = 0.60; reasons.push("severity ≥0.85 → paper only; 10 wins ≥60% to restore"); }
  else if (input.severity01 >= 0.65) { forced = true; requiredPaperWinsToRestore = 5;  minPaperWinRate = 0.55; reasons.push("severity ≥0.65 → paper only; 5 wins ≥55% to restore"); }
  else if (input.ruleViolationsLast24h >= 3) {
    forced = true; requiredPaperWinsToRestore = 3; minPaperWinRate = 0.50;
    reasons.push("≥3 rule violations in 24h → paper only; 3 wins ≥50% to restore");
  }

  return { forced, requiredPaperWinsToRestore, minPaperWinRate, reasons };
}
