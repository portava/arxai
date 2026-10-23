import {
  type SampleSizeInput, type SampleSizeRecommendation,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Sample Size Optimizer — adaptive minimum trade count using a normal-
// approximation two-sided z formula:
//
//   n ≈ ((zα/2 + zβ) · σ / Δ)²
//
// where σ = observed per-trade R standard deviation, Δ = target effect
// size in R units, zα/2 = critical value for confidence, zβ = critical
// value for desired power. Result is clamped to [hardMin, hardCap].
//
// Pure. We use small lookup tables to avoid pulling in a stats lib.
// ═══════════════════════════════════════════════════════════════════════════

// Two-sided z critical values (zα/2). Common confidences only.
const Z_TWO_SIDED: ReadonlyArray<readonly [number, number]> = [
  [0.80, 1.282],
  [0.90, 1.645],
  [0.95, 1.960],
  [0.975, 2.241],
  [0.99, 2.576],
  [0.995, 2.807],
  [0.999, 3.291],
];

// One-sided z for power (zβ).
const Z_ONE_SIDED: ReadonlyArray<readonly [number, number]> = [
  [0.80, 0.842],
  [0.85, 1.036],
  [0.90, 1.282],
  [0.95, 1.645],
  [0.975, 1.960],
  [0.99, 2.326],
];

function zFromTable(table: ReadonlyArray<readonly [number, number]>, target: number): number {
  // Find nearest tabulated value at or above target; fall back to last.
  for (const [p, z] of table) if (p >= target) return z;
  return table[table.length - 1]![1];
}

export function recommendSampleSize(input: SampleSizeInput): SampleSizeRecommendation {
  const reasons: string[] = [];

  // Defensive bounds normalisation. If a caller passes hardMin > hardCap
  // the documented [hardMin, hardCap] clamp would be vacuous, so we
  // collapse to the cap and surface a structured reason. hardCap is the
  // ceiling of truth — never exceed it.
  let hardMin = input.hardMin;
  let hardCap = input.hardCap;
  if (hardMin > hardCap) {
    reasons.push(`hardMin ${hardMin} > hardCap ${hardCap} — pinning hardMin to hardCap`);
    hardMin = hardCap;
  }

  if (input.targetEffectSizeR <= 0) {
    return {
      candidateId: input.candidateId,
      recommendedTrades: hardMin,
      currentTrades: input.currentTrades,
      sufficient: input.currentTrades >= hardMin,
      reasons: [...reasons, `targetEffectSizeR must be > 0 — falling back to hardMin ${hardMin}`],
    };
  }
  if (input.observedSampleStdR === 0) {
    return {
      candidateId: input.candidateId,
      recommendedTrades: hardMin,
      currentTrades: input.currentTrades,
      sufficient: input.currentTrades >= hardMin,
      reasons: [...reasons, `observedSampleStdR is 0 — using hardMin ${hardMin}`],
    };
  }

  const zAlpha = zFromTable(Z_TWO_SIDED, input.confidence01);
  const zBeta  = zFromTable(Z_ONE_SIDED, input.power01);
  const ratio  = input.observedSampleStdR / input.targetEffectSizeR;
  const raw    = Math.pow((zAlpha + zBeta) * ratio, 2);
  // Apply cap first then floor so the result is ALWAYS ≤ hardCap regardless
  // of the order of operations.
  const recommended = Math.max(hardMin, Math.min(hardCap, Math.ceil(raw)));

  reasons.push(
    `zα/2 ${zAlpha.toFixed(3)} · zβ ${zBeta.toFixed(3)} · σ/Δ ${ratio.toFixed(3)} · ` +
    `raw ${Math.ceil(raw)} → clamped ${recommended}`);
  if (recommended === hardCap && raw > hardCap) {
    reasons.push(`recommended hit hardCap ${hardCap}; effect may be too small to detect economically`);
  }

  return {
    candidateId: input.candidateId,
    recommendedTrades: recommended,
    currentTrades: input.currentTrades,
    sufficient: input.currentTrades >= recommended,
    reasons,
  };
}
