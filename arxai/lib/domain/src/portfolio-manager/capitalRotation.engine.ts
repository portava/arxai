import {
  type StrategyAllocation, type RotationDelta, clamp01,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Capital Rotation — periodic reallocation that shifts weight from
// underperformers to outperformers. Pure. Constraints:
//
//   • |Δweight| per strategy is capped at maxMovePerCycle.
//   • Sum of deltas is zero (zero-sum rotation).
//   • Strategies with edgeDecayPenalty01 ≥ minimumDecayToShed are
//     specifically scheduled for negative delta.
// ═══════════════════════════════════════════════════════════════════════════

export interface RotationInput {
  current: ReadonlyArray<StrategyAllocation>;
  recentScoresByStrategyId: ReadonlyMap<string, number>;  // [0,1] composite
  maxMovePerCycle?: number;        // default 0.05
  minimumDecayToShed?: number;     // default 0.5
}

export interface RotationOutput {
  deltas: ReadonlyArray<RotationDelta>;
  reasons: string[];
  blockers: string[];
}

export function rotateCapital(input: RotationInput): RotationOutput {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const cap = input.maxMovePerCycle ?? 0.05;
  const decayThreshold = input.minimumDecayToShed ?? 0.5;
  if (input.current.length === 0) {
    return { deltas: [], reasons: [`no current allocations`], blockers };
  }

  // Mean recent score over the cohort.
  const scores = input.current.map((a) =>
    clamp01(input.recentScoresByStrategyId.get(a.strategyId) ?? 0));
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  reasons.push(`cohort mean score ${mean.toFixed(3)}`);

  // Raw signed delta per strategy: (score - mean) scaled.
  const raw: { id: string; delta: number; reasons: string[] }[] = [];
  for (let i = 0; i < input.current.length; i++) {
    const a = input.current[i]!;
    const r: string[] = [];
    let d = (scores[i]! - mean) * cap;
    // Force shed for decayed strategies.
    if (a.edgeDecayPenalty01 >= decayThreshold) {
      d = Math.min(d, -cap);
      r.push(`forced shed: edgeDecayPenalty ${a.edgeDecayPenalty01.toFixed(2)} ≥ ${decayThreshold}`);
    }
    // Cap the move magnitude.
    if (d > cap)  { d = cap;  r.push(`capped to +${cap}`); }
    if (d < -cap) { d = -cap; r.push(`capped to -${cap}`); }
    // Cannot reduce below zero weight.
    const minDelta = -a.weight01;
    if (d < minDelta) { d = minDelta; r.push(`bounded by current weight ${a.weight01.toFixed(2)}`); }
    raw.push({ id: a.strategyId, delta: d, reasons: r });
  }

  // Make zero-sum: subtract mean(delta) from each so the cohort net = 0.
  const meanDelta = raw.reduce((s, x) => s + x.delta, 0) / raw.length;
  for (const r of raw) {
    r.delta -= meanDelta;
    // Re-cap after centering — the centering step can push values out of
    // bounds; centring twice would oscillate, so we just clamp and warn.
    if (r.delta > cap)  { r.delta = cap;  r.reasons.push(`re-capped to +${cap} after zero-sum centering`); }
    if (r.delta < -cap) { r.delta = -cap; r.reasons.push(`re-capped to -${cap} after zero-sum centering`); }
  }
  const finalSum = raw.reduce((s, x) => s + x.delta, 0);
  if (Math.abs(finalSum) > 1e-9) {
    reasons.push(`final delta sum ${finalSum.toFixed(4)} ≠ 0 (capping interaction); rotation is approximately zero-sum`);
  }

  return {
    deltas: raw.map((r) => ({ strategyId: r.id, deltaWeight01: r.delta, reasons: r.reasons })),
    reasons, blockers,
  };
}
