import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Stress Lab — TYPES
// Self-contained subdomain. Generates synthetic extreme market scenarios
// for stress-testing strategies. SIMULATION ONLY — never places trades,
// never connects to live execution. Each engine is pure & deterministic
// given a seed.
// ═══════════════════════════════════════════════════════════════════════════

export const ScenarioKindSchema = z.enum([
  "FLASH_CRASH", "LIQUIDITY_COLLAPSE", "SLIPPAGE_STORM",
  "NEWS_CHAOS", "FAKE_BREAKOUT",
]);
export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

export const SyntheticTickSchema = z.object({
  tsMs: z.number().nonnegative(),
  bid: z.number().positive(),
  ask: z.number().positive(),
  volume: z.number().nonnegative(),
  spreadPips: z.number().nonnegative(),
});
export type SyntheticTick = z.infer<typeof SyntheticTickSchema>;

export const ScenarioOutputSchema = z.object({
  kind: ScenarioKindSchema,
  seed: z.int().nonnegative(),
  durationMs: z.number().positive(),
  ticks: z.array(SyntheticTickSchema),
  expectedShockPctMove: z.number(),       // peak vs initial price (signed)
  peakSpreadPips: z.number().nonnegative(),
  isSimulationOnly: z.literal(true),       // hard marker — never live
  reasons: z.array(z.string()),
});
export type ScenarioOutput = z.infer<typeof ScenarioOutputSchema>;

// Mulberry32 deterministic PRNG (shared helper).
export function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
