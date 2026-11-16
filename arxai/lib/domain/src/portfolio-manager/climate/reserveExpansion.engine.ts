import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Reserve Expansion — dynamic top-up of the reserve fraction in response
// to climate / preservation / drawdown signals.
//
// Adds up to +0.40 to baseReserveFraction; final reserve is clamped to 0.95
// to leave a residual deployable cushion.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ReserveExpansionInputSchema = z.object({
  baseReserveFraction01: z.number().min(0).max(1),
  climateScore01: z.number().min(0).max(1),
  preservationScore01: z.number().min(0).max(1),
  accountDrawdownFraction01: z.number().min(0).max(1),
});
export type ReserveExpansionInput = z.infer<typeof ReserveExpansionInputSchema>;

export interface ReserveExpansionOutput {
  expandedReserveFraction01: number;
  addedFraction01: number;
  reasons: string[];
}

const MAX_RESERVE = 0.95;

export function expandReserve(i: ReserveExpansionInput): ReserveExpansionOutput {
  const base = clamp01(i.baseReserveFraction01);
  const reasons: string[] = [`base reserveFraction ${base.toFixed(3)}`];
  // Climate add-on: storms add up to +0.25.
  const climateAdd = (1 - clamp01(i.climateScore01)) * 0.25;
  // Preservation add-on: defensive/bunker postures add up to +0.10.
  const preservationAdd = clamp01(i.preservationScore01) * 0.10;
  // Drawdown add-on: deep drawdown adds up to +0.05 (modest, dd is dominant elsewhere).
  const ddAdd = clamp01(i.accountDrawdownFraction01) * 0.05;
  const added = climateAdd + preservationAdd + ddAdd;
  reasons.push(`climateAdd ${climateAdd.toFixed(3)}, preservationAdd ${preservationAdd.toFixed(3)}, ddAdd ${ddAdd.toFixed(3)}`);
  const expanded = Math.min(MAX_RESERVE, base + added);
  reasons.push(`expanded reserveFraction ${expanded.toFixed(3)}`);
  return { expandedReserveFraction01: expanded, addedFraction01: expanded - base, reasons };
}
