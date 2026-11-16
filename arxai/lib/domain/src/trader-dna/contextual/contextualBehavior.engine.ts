// ═══════════════════════════════════════════════════════════════════════════
// Contextual Behavior Composer
//
// Combines trader state with environmental context — market regime,
// volatility band, execution stress, council disagreement, global market
// state — to produce a single context-adjusted behavior risk score and
// the dominant amplifier(s).
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { analyzeMarketBehaviorInteraction, MarketRegimeSchema, type MarketRegime } from "./marketBehaviorInteraction.engine";
import { analyzeVolatilityBehaviorInteraction, VolatilityBandSchema, type VolatilityBand } from "./volatilityBehaviorInteraction.engine";
import { analyzeExecutionStressBehavior, ExecutionStressInputSchema, type ExecutionStressInput } from "./executionStressBehavior.engine";

export const GlobalMarketStateSchema = z.enum(["GREEN", "YELLOW", "ORANGE", "RED", "LOCKDOWN"]);
export type GlobalMarketState = z.infer<typeof GlobalMarketStateSchema>;

export const ContextualBehaviorInputSchema = z.object({
  behaviorRiskScore01:     z.number().min(0).max(1),
  marketRegime:            MarketRegimeSchema,
  volatilityBand:          VolatilityBandSchema,
  exec:                    ExecutionStressInputSchema,
  councilDisagreement01:   z.number().min(0).max(1).default(0),
  globalMarketState:       GlobalMarketStateSchema.default("GREEN"),
}).strict();
export type ContextualBehaviorInput = z.infer<typeof ContextualBehaviorInputSchema>;

export const ContextualBehaviorReportSchema = z.object({
  baseRiskScore01:        z.number().min(0).max(1),
  adjustedRiskScore01:    z.number().min(0).max(1),
  totalMultiplier:        z.number().positive(),
  dominantAmplifier:      z.string(),
  components: z.object({
    market:    z.object({ multiplier: z.number(), reason: z.string() }),
    vol:       z.object({ multiplier: z.number(), reason: z.string() }),
    exec:      z.object({ multiplier: z.number(), reason: z.string(), score01: z.number() }),
    council:   z.object({ multiplier: z.number(), reason: z.string() }),
    global:    z.object({ multiplier: z.number(), reason: z.string() }),
  }),
  neutralLanguage: z.string(),
});
export type ContextualBehaviorReport = z.infer<typeof ContextualBehaviorReportSchema>;

export function composeContextualBehavior(input: ContextualBehaviorInput): ContextualBehaviorReport {
  const market = analyzeMarketBehaviorInteraction({ regime: input.marketRegime, behaviorRiskScore01: input.behaviorRiskScore01 });
  const vol    = analyzeVolatilityBehaviorInteraction({ band: input.volatilityBand, behaviorRiskScore01: input.behaviorRiskScore01 });
  const exec   = analyzeExecutionStressBehavior({ exec: input.exec, behaviorRiskScore01: input.behaviorRiskScore01 });
  const councilM = 1 + input.councilDisagreement01 * 0.30;
  const globalM  = ({ GREEN: 1.00, YELLOW: 1.10, ORANGE: 1.25, RED: 1.45, LOCKDOWN: 1.60 } as const)[input.globalMarketState];
  const total = market.contextMultiplier * vol.contextMultiplier * exec.contextMultiplier * councilM * globalM;
  const adjusted = clamp01(input.behaviorRiskScore01 * total);
  // Dominant amplifier
  const amps: { name: string; m: number }[] = [
    { name: `MARKET:${market.regime}`,       m: market.contextMultiplier },
    { name: `VOL:${vol.band}`,               m: vol.contextMultiplier },
    { name: `EXEC_STRESS`,                   m: exec.contextMultiplier },
    { name: `COUNCIL_DISAGREEMENT`,          m: councilM },
    { name: `GLOBAL:${input.globalMarketState}`, m: globalM },
  ];
  const dominant = amps.reduce((a, b) => a.m > b.m ? a : b);
  return {
    baseRiskScore01: input.behaviorRiskScore01,
    adjustedRiskScore01: adjusted,
    totalMultiplier: round2(total),
    dominantAmplifier: dominant.name,
    components: {
      market:  { multiplier: market.contextMultiplier, reason: market.neutralLanguage },
      vol:     { multiplier: vol.contextMultiplier,    reason: vol.neutralLanguage },
      exec:    { multiplier: exec.contextMultiplier,   reason: exec.neutralLanguage, score01: exec.executionStressScore01 },
      council: { multiplier: round2(councilM),         reason: `Council disagreement ${input.councilDisagreement01.toFixed(2)} → ×${councilM.toFixed(2)}` },
      global:  { multiplier: globalM,                  reason: `Global state ${input.globalMarketState} → ×${globalM.toFixed(2)}` },
    },
    neutralLanguage: `Base risk ${input.behaviorRiskScore01.toFixed(2)} → adjusted ${adjusted.toFixed(2)} (×${total.toFixed(2)}); dominant amplifier: ${dominant.name}.`,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
