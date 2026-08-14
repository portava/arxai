import { clamp01 } from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Performance-Weighted Allocation — pure transform from per-strategy
// composite scores to weights summing to 1. Uses softmax with a
// configurable temperature so the caller can choose between "equal-ish"
// (high temp) and "winner-take-most" (low temp) behaviour.
//
// • Temperature must be > 0; <=0 falls back to argmax.
// • Inputs are clamped to [0,1]; non-finite scores treated as 0.
// • Empty input returns an empty Map (NOT an error).
// ═══════════════════════════════════════════════════════════════════════════

export interface PerformanceInput {
  scoresByStrategyId: ReadonlyMap<string, number>;
  temperature?: number;          // default 0.5
}

export interface PerformanceOutput {
  weightsByStrategyId: ReadonlyMap<string, number>;
  reasons: string[];
}

export function performanceWeightedAllocation(input: PerformanceInput): PerformanceOutput {
  const reasons: string[] = [];
  const temp = input.temperature ?? 0.5;
  const weights = new Map<string, number>();
  if (input.scoresByStrategyId.size === 0) {
    reasons.push(`empty input — returning empty allocation`);
    return { weightsByStrategyId: weights, reasons };
  }

  const ids = [...input.scoresByStrategyId.keys()];
  const xs  = ids.map((id) => clamp01(input.scoresByStrategyId.get(id) ?? 0));

  if (temp <= 0) {
    // Argmax fallback — full weight on the highest score.
    const max = Math.max(...xs);
    const top = ids.find((_, i) => xs[i] === max) ?? ids[0]!;
    for (const id of ids) weights.set(id, id === top ? 1 : 0);
    reasons.push(`argmax → ${top} (temperature ${temp} ≤ 0)`);
    return { weightsByStrategyId: weights, reasons };
  }

  // Softmax with shift for numerical stability.
  const shifted = xs.map((x) => x / temp);
  const maxShift = Math.max(...shifted);
  const exps = shifted.map((s) => Math.exp(s - maxShift));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (sum === 0 || !Number.isFinite(sum)) {
    // Degenerate — fall back to uniform.
    const u = 1 / ids.length;
    for (const id of ids) weights.set(id, u);
    reasons.push(`degenerate softmax — uniform fallback (${u.toFixed(3)} each)`);
    return { weightsByStrategyId: weights, reasons };
  }
  for (let i = 0; i < ids.length; i++) weights.set(ids[i]!, exps[i]! / sum);
  reasons.push(`softmax over ${ids.length} strategies @ T=${temp}`);
  return { weightsByStrategyId: weights, reasons };
}
