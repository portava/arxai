import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Mutation — produce N parameter mutations from a parent. Pure
// (deterministic given a seed). Bounded perturbations only — mutations
// CANNOT push parameters outside their declared safe ranges.
// ═══════════════════════════════════════════════════════════════════════════

export const ParamRangeSchema = z.object({
  name: z.string().min(1),
  current: z.number(),
  min: z.number(),
  max: z.number(),
  // Maximum perturbation as fraction of (max-min). Defensive cap 0..1.
  maxPerturbation01: z.number().min(0).max(1),
});
export type ParamRange = z.infer<typeof ParamRangeSchema>;

export const MutationInputsSchema = z.object({
  parentStrategyId: z.string().min(1),
  parameters: z.array(ParamRangeSchema),
  variantCount: z.int().positive().max(64),
  rngSeed: z.int(),
});
export type MutationInputs = z.infer<typeof MutationInputsSchema>;

export const StrategyVariantSchema = z.object({
  variantId: z.string().min(1),
  parentStrategyId: z.string().min(1),
  parameters: z.array(z.object({ name: z.string(), value: z.number() })),
  rngSeed: z.int(),
  reasons: z.array(z.string()),
});
export type StrategyVariant = z.infer<typeof StrategyVariantSchema>;

export interface MutationResult {
  variants: StrategyVariant[];
  reasons: string[];
  blockers: string[];
}

export function mutateStrategy(i: MutationInputs): MutationResult {
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Defensive: validate parameter ranges before mutating.
  for (const p of i.parameters) {
    if (p.min > p.max) {
      blockers.push(`param ${p.name}: min ${p.min} > max ${p.max}`);
    }
    if (p.current < p.min || p.current > p.max) {
      blockers.push(`param ${p.name}: current ${p.current} outside [${p.min}, ${p.max}]`);
    }
  }
  if (blockers.length > 0) return { variants: [], reasons, blockers };

  let rng = mulberry32(i.rngSeed);
  const variants: StrategyVariant[] = [];
  for (let v = 0; v < i.variantCount; v++) {
    const params = i.parameters.map((p) => {
      const span = p.max - p.min;
      const maxStep = span * p.maxPerturbation01;
      // Symmetric perturbation in [-maxStep, +maxStep].
      const delta = (rng() * 2 - 1) * maxStep;
      const raw = p.current + delta;
      // Defensive clamp to declared range.
      const value = Math.max(p.min, Math.min(p.max, raw));
      return { name: p.name, value };
    });
    variants.push({
      variantId: `${i.parentStrategyId}.v${v + 1}`,
      parentStrategyId: i.parentStrategyId,
      parameters: params,
      rngSeed: i.rngSeed + v,
      reasons: [`bounded perturbation around parent (seed=${i.rngSeed + v})`],
    });
  }
  reasons.push(`generated ${variants.length} bounded variants of ${i.parentStrategyId}`);
  return { variants, reasons, blockers };
}

// Tiny, deterministic, hash-quality-enough PRNG. Avoids importing anything.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
