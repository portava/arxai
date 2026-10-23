import { z } from "zod/v4";
import { SymbolIdSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Liquidity-Aware Deployment — per-symbol multiplier in [0.3, 1.0] that
// REDUCES sizing when symbol liquidity is poor. Never amplifies above 1.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const LiquidityInputSchema = z.object({
  symbolId: SymbolIdSchema,
  liquidity01: z.number().min(0).max(1),
});
export type LiquidityInput = z.infer<typeof LiquidityInputSchema>;

export const LIQ_BOUNDS = { min: 0.3, max: 1.0 } as const;

export interface LiquidityAwareDeploymentOutput {
  perSymbol: ReadonlyArray<{
    symbolId: string; multiplier: number; reasons: string[];
  }>;
  multipliersById: ReadonlyMap<string, number>;
}

export function liquidityAwareDeployment(
  inputs: ReadonlyArray<LiquidityInput>,
): LiquidityAwareDeploymentOutput {
  const map = new Map<string, number>();
  const perSymbol = inputs.map((s) => {
    const q = clamp01(s.liquidity01);
    // q=0 → 0.3 cut, q=1 → no cut (multiplier 1.0).
    const m = LIQ_BOUNDS.min + q * (LIQ_BOUNDS.max - LIQ_BOUNDS.min);
    map.set(s.symbolId, m);
    return {
      symbolId: s.symbolId,
      multiplier: m,
      reasons: [`liquidity ${q.toFixed(2)} → multiplier ${m.toFixed(3)}`],
    };
  });
  return { perSymbol, multipliersById: map };
}
