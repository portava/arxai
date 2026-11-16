import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Variation Testing — design and aggregate A/B/N comparisons in the
// sandbox. Pure functions: caller runs the simulator, feeds results back.
// We compute relative performance vs parent baseline + statistical
// strength signals.
// ═══════════════════════════════════════════════════════════════════════════

export const VariantResultSchema = z.object({
  variantId: z.string().min(1),
  sampleCount: z.int().nonnegative(),
  expectancyR: z.number(),
  winRate01: z.number().min(0).max(1),
  maxDrawdownPct: z.number().min(0),
  isParentBaseline: z.boolean().default(false),
});
export type VariantResult = z.infer<typeof VariantResultSchema>;

export const VariationTestInputsSchema = z.object({
  parentStrategyId: z.string().min(1),
  results: z.array(VariantResultSchema),
});
export type VariationTestInputs = z.infer<typeof VariationTestInputsSchema>;

export const VARIATION_TUNING = {
  minSamplesPerVariant: 100,
  // A variant must beat parent expectancy by at least this absolute R.
  minExpectancyLiftR: 0.03,
  // And not blow up worse than parent drawdown by more than this multiple.
  maxDrawdownMultiplier: 1.10,
  // When parent baseline drawdown is zero, fall back to this absolute ceiling
  // (variants must remain almost as clean as a no-loss parent).
  zeroBaselineDdAbsolutePct: 1.0,
} as const;

export interface VariantRanking {
  variantId: string;
  expectancyR: number;
  expectancyLiftR: number;
  drawdownVsParent01: number;                // 1 = same as parent, >1 = worse
  qualifies: boolean;
  reasons: string[];
}

export interface VariationTestResult {
  parentBaseline: VariantResult | null;
  rankings: VariantRanking[];
  qualifyingVariantIds: string[];
  reasons: string[];
  blockers: string[];
}

export function evaluateVariations(i: VariationTestInputs): VariationTestResult {
  const T = VARIATION_TUNING;
  const reasons: string[] = [];
  const blockers: string[] = [];

  const baseline = i.results.find((r) => r.isParentBaseline) ?? null;
  if (!baseline) {
    blockers.push(`no parent baseline result provided — cannot rank variants`);
    return { parentBaseline: null, rankings: [], qualifyingVariantIds: [], reasons, blockers };
  }
  if (baseline.sampleCount < T.minSamplesPerVariant) {
    blockers.push(`parent baseline samples ${baseline.sampleCount} < ${T.minSamplesPerVariant}`);
  }

  const variants = i.results.filter((r) => !r.isParentBaseline);
  const rankings: VariantRanking[] = variants.map((r) => {
    const reasons: string[] = [];
    const lift = r.expectancyR - baseline.expectancyR;
    // Defensive: when parent baseline drawdown is zero we cannot compute a
    // ratio (would divide by zero). Fall back to an ABSOLUTE drawdown floor
    // — any variant with non-trivial drawdown vs a clean parent fails.
    const baselineHasDd = baseline.maxDrawdownPct > 0;
    const ddRatio = baselineHasDd ? r.maxDrawdownPct / baseline.maxDrawdownPct : Number.POSITIVE_INFINITY;
    const ddAbsoluteFails = !baselineHasDd && r.maxDrawdownPct > T.zeroBaselineDdAbsolutePct;
    let qualifies = true;
    if (r.sampleCount < T.minSamplesPerVariant) {
      qualifies = false;
      reasons.push(`samples ${r.sampleCount} < ${T.minSamplesPerVariant}`);
    }
    if (lift < T.minExpectancyLiftR) {
      qualifies = false;
      reasons.push(`expectancy lift ${lift.toFixed(3)} < min ${T.minExpectancyLiftR}`);
    }
    if (baselineHasDd && ddRatio > T.maxDrawdownMultiplier) {
      qualifies = false;
      reasons.push(`drawdown ${ddRatio.toFixed(2)}× parent > max ${T.maxDrawdownMultiplier}×`);
    }
    if (ddAbsoluteFails) {
      qualifies = false;
      reasons.push(`parent baseline drawdown=0 but variant drawdown ${r.maxDrawdownPct.toFixed(2)}% > absolute floor ${T.zeroBaselineDdAbsolutePct}%`);
    }
    if (qualifies) reasons.push(`qualifies — lift ${lift.toFixed(3)}, dd ${ddRatio.toFixed(2)}× parent`);
    return {
      variantId: r.variantId,
      expectancyR: r.expectancyR,
      expectancyLiftR: lift,
      drawdownVsParent01: ddRatio,
      qualifies,
      reasons,
    };
  });

  rankings.sort((a, b) => b.expectancyLiftR - a.expectancyLiftR);
  const qualifyingVariantIds = rankings.filter((r) => r.qualifies).map((r) => r.variantId);

  reasons.push(`evaluated ${variants.length} variants vs parent ${i.parentStrategyId} baseline expectancy ${baseline.expectancyR.toFixed(3)}`);
  reasons.push(`${qualifyingVariantIds.length} variant(s) qualify for next stage`);
  return { parentBaseline: baseline, rankings, qualifyingVariantIds, reasons, blockers };
}
