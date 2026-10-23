// Task #199 — Ruby learning-threshold defaults + validation. PURE.
//
// These knobs tune how OUTCOME LEARNING classifies signals (late entry,
// confidence/edge floors, news lockout, spread/slippage caps, R:R floor,
// decisive-move floor, evidence expiry). They are ADVISORY/LEARNING only — they
// NEVER feed the 16-gate live pipeline, kill switch, or any broker dispatch.
//
// clampThresholds enforces sane bounds so an audited admin change can never push
// a value negative or absurd. Defaults mirror the proven resolver constants
// (BREAKEVEN_R=0.25, STRONG_MOVE_PCT=0.4) so reporting stays consistent.

export interface RubyQualityThresholds {
  lateEntrySeconds: number;
  minConfidence: number;
  minEdge: number;
  newsLockoutMinutes: number;
  maxSpread: number;
  maxSlippage: number;
  minRiskReward: number;
  strongMovePct: number;
  breakevenR: number;
  evidenceExpiryMinutes: number;
}

export const DEFAULT_RUBY_THRESHOLDS: RubyQualityThresholds = {
  lateEntrySeconds: 120,
  minConfidence: 60,
  minEdge: 50,
  newsLockoutMinutes: 30,
  maxSpread: 2.5,
  maxSlippage: 1.5,
  minRiskReward: 1.5,
  strongMovePct: 0.4,
  breakevenR: 0.25,
  evidenceExpiryMinutes: 240,
};

interface Bound { min: number; max: number; integer?: boolean }

export const THRESHOLD_BOUNDS: Record<keyof RubyQualityThresholds, Bound> = {
  lateEntrySeconds:      { min: 0, max: 3600, integer: true },
  minConfidence:         { min: 0, max: 100 },
  minEdge:               { min: 0, max: 100 },
  newsLockoutMinutes:    { min: 0, max: 240, integer: true },
  maxSpread:             { min: 0, max: 100 },
  maxSlippage:           { min: 0, max: 100 },
  minRiskReward:         { min: 0, max: 20 },
  strongMovePct:         { min: 0.01, max: 50 },
  breakevenR:            { min: 0, max: 5 },
  evidenceExpiryMinutes: { min: 1, max: 10080, integer: true },
};

export const TUNABLE_THRESHOLD_KEYS = Object.keys(THRESHOLD_BOUNDS) as (keyof RubyQualityThresholds)[];

function clampOne(key: keyof RubyQualityThresholds, value: number): number {
  const b = THRESHOLD_BOUNDS[key];
  let v = Number(value);
  if (!Number.isFinite(v)) return DEFAULT_RUBY_THRESHOLDS[key];
  v = Math.max(b.min, Math.min(b.max, v));
  return b.integer ? Math.round(v) : v;
}

/**
 * Merge a partial update onto a base set, clamping every field. Unknown keys are
 * dropped. The result is always a complete, valid threshold set.
 */
export function clampThresholds(
  patch: Partial<Record<keyof RubyQualityThresholds, number>>,
  base: RubyQualityThresholds = DEFAULT_RUBY_THRESHOLDS,
): RubyQualityThresholds {
  const out = { ...base };
  for (const key of TUNABLE_THRESHOLD_KEYS) {
    const raw = patch[key];
    if (raw == null) continue;
    out[key] = clampOne(key, raw);
  }
  return out;
}
