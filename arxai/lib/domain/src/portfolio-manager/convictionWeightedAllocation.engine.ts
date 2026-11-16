import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Conviction-Weighted Allocation
//
// Per-strategy multiplier in [0.2, 1.5] derived from conviction calibration:
//
//   • A well-calibrated, high-conviction strategy can be UPSIZED (>1).
//   • A poorly-calibrated, high-conviction strategy ("bad winning" /
//     overconfident) is REDUCED (<1) regardless of recent expectancy.
//   • Low-sample-size strategies are shrunk toward 1 (no boost without
//     evidence) — sample-shrinkage is monotonic.
//   • Bad-winning override: positive recent expectancy with poor calibration
//     is treated as a hazard, not a virtue.
//
// Pure. Returns a multiplier map plus per-strategy reasons.
// ═══════════════════════════════════════════════════════════════════════════

export const ConvictionInputSchema = z.object({
  strategyId: StrategyIdSchema,
  conviction01: z.number().min(0).max(1),
  calibration01: z.number().min(0).max(1),
  sampleSize: z.number().int().nonnegative(),
  recentExpectancyR: z.number(),
});
export type ConvictionInput = z.infer<typeof ConvictionInputSchema>;

export const StrategyMultiplierSchema = z.object({
  strategyId: StrategyIdSchema,
  multiplier: z.number().nonnegative(),
  reasons: z.array(z.string()),
});
export type StrategyMultiplier = z.infer<typeof StrategyMultiplierSchema>;

export interface ConvictionAllocationOutput {
  multipliers: ReadonlyArray<StrategyMultiplier>;
  multipliersById: ReadonlyMap<string, number>;
  reasons: string[];
}

export const CONVICTION_BOUNDS = { min: 0.2, max: 1.5 } as const;

export function convictionWeightedAllocation(
  inputs: ReadonlyArray<ConvictionInput>,
): ConvictionAllocationOutput {
  const reasons: string[] = [];
  const multipliers: StrategyMultiplier[] = [];
  const map = new Map<string, number>();

  for (const inp of inputs) {
    const r: string[] = [];
    const conv = clamp01(inp.conviction01);
    const cal = clamp01(inp.calibration01);

    // Base: linear in conviction, range [0.5, 1.1].
    let m = 0.5 + conv * 0.6;
    r.push(`base ${m.toFixed(3)} (conv ${conv.toFixed(2)})`);

    // Calibration scaling: well-calibrated boosts; mid is neutral; poor cuts.
    // multiplicative factor in [0.6, 1.2] centered around cal=0.6.
    const calFactor = 0.6 + cal * 0.6;
    m *= calFactor;
    r.push(`× calFactor ${calFactor.toFixed(3)} (cal ${cal.toFixed(2)})`);

    // Sample shrinkage FIRST: pull toward 1 when undersampled. Hazard caps
    // below are applied AFTER shrinkage so undersampled overconfidence
    // cannot escape the bad-winning ceiling.
    if (inp.sampleSize < 10) {
      const w = inp.sampleSize / 10;
      const before = m;
      m = 1 + (m - 1) * w;
      r.push(`sample shrinkage n=${inp.sampleSize} → w=${w.toFixed(2)}: ` +
             `${before.toFixed(3)} → ${m.toFixed(3)}`);
    }

    // Bad-winning override: high conviction + low calibration is HAZARDOUS.
    // Hard-cap at 0.5 regardless of sample size; rewarding overconfidence
    // (especially when R is positive) is poison.
    if (cal < 0.4 && conv >= 0.7) {
      m = Math.min(m, 0.5);
      r.push(`bad-winning override: high conviction (${conv.toFixed(2)}) ` +
             `with poor calibration (${cal.toFixed(2)}) — hard cap at 0.5`);
    }

    // Extra penalty for positive expectancy WITH poor calibration.
    if (inp.recentExpectancyR > 0 && cal < 0.4) {
      m *= 0.7;
      r.push(`× 0.700 bad-winning expectancy penalty (R+ but cal<0.4)`);
    }

    // Final clamp.
    const final = Math.min(CONVICTION_BOUNDS.max, Math.max(CONVICTION_BOUNDS.min, m));
    if (final !== m) r.push(`clamped to [${CONVICTION_BOUNDS.min}, ${CONVICTION_BOUNDS.max}] → ${final.toFixed(3)}`);

    multipliers.push({ strategyId: inp.strategyId, multiplier: final, reasons: r });
    map.set(inp.strategyId, final);
  }

  reasons.push(`computed conviction multipliers for ${inputs.length} strategies`);
  return { multipliers, multipliersById: map, reasons };
}
