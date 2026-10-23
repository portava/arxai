import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "./portfolio.types";
import { type StrategyMultiplier } from "./convictionWeightedAllocation.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Survival-Weighted Allocation
//
// Per-strategy multiplier in [0.1, 1.3] that prioritizes long-term
// survivability over short-term expectancy:
//
//   • Composite safety = survivalScore + drawdownBehavior + (1 - ruinProb).
//   • Under DANGEROUS conditions (high regime uncertainty, deep drawdown),
//     the deviation from 1 is AMPLIFIED — survivors get more, fragile
//     strategies get cut harder.
//   • Catastrophic ruinProb (>0.5) hard-caps the multiplier at 0.4.
//   • Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const SurvivalInputSchema = z.object({
  strategyId: StrategyIdSchema,
  survivalScore01: z.number().min(0).max(1),
  ruinProbability01: z.number().min(0).max(1),
  drawdownBehavior01: z.number().min(0).max(1),
  recentExpectancyR: z.number(),
});
export type SurvivalInput = z.infer<typeof SurvivalInputSchema>;

export interface SurvivalAllocationInput {
  strategies: ReadonlyArray<SurvivalInput>;
  /** Global danger level [0..1]. Typically max(regimeUncertainty, accountDrawdown). */
  dangerLevel01: number;
}

export interface SurvivalAllocationOutput {
  multipliers: ReadonlyArray<StrategyMultiplier>;
  multipliersById: ReadonlyMap<string, number>;
  reasons: string[];
}

export const SURVIVAL_BOUNDS = { min: 0.1, max: 1.3 } as const;

export function survivalWeightedAllocation(
  input: SurvivalAllocationInput,
): SurvivalAllocationOutput {
  const reasons: string[] = [];
  const danger = clamp01(input.dangerLevel01);
  reasons.push(`global dangerLevel ${danger.toFixed(2)}`);

  const multipliers: StrategyMultiplier[] = [];
  const map = new Map<string, number>();

  for (const s of input.strategies) {
    const r: string[] = [];
    const surv = clamp01(s.survivalScore01);
    const ddb = clamp01(s.drawdownBehavior01);
    const ruin = clamp01(s.ruinProbability01);

    // Composite safety in [0,1]: weighted toward survival.
    const safety = 0.45 * surv + 0.35 * ddb + 0.20 * (1 - ruin);
    r.push(`safety ${safety.toFixed(3)} (surv ${surv.toFixed(2)}, ddBeh ${ddb.toFixed(2)}, ruin ${ruin.toFixed(2)})`);

    // Base multiplier: safety drives [0.5, 1.1].
    let m = 0.5 + safety * 0.6;
    r.push(`base ${m.toFixed(3)}`);

    // Danger amplification: amplify deviation from 1.0 by (1 + danger).
    // Survivors get more, fragile strategies get cut harder.
    const before = m;
    m = 1 + (m - 1) * (1 + danger);
    r.push(`danger amplify × ${(1 + danger).toFixed(2)}: ${before.toFixed(3)} → ${m.toFixed(3)}`);

    // Hard ruin override: catastrophic ruin probability caps at 0.4.
    if (ruin > 0.5) {
      m = Math.min(m, 0.4);
      r.push(`ruin override: ruinProb ${ruin.toFixed(2)} > 0.5 — hard cap at 0.4`);
    }

    // Final clamp.
    const final = Math.min(SURVIVAL_BOUNDS.max, Math.max(SURVIVAL_BOUNDS.min, m));
    if (final !== m) r.push(`clamped to [${SURVIVAL_BOUNDS.min}, ${SURVIVAL_BOUNDS.max}] → ${final.toFixed(3)}`);

    multipliers.push({ strategyId: s.strategyId, multiplier: final, reasons: r });
    map.set(s.strategyId, final);
  }

  reasons.push(`computed survival multipliers for ${input.strategies.length} strategies`);
  return { multipliers, multipliersById: map, reasons };
}
