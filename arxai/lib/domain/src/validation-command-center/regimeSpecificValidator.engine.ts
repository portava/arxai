// ═══════════════════════════════════════════════════════════════════════════
// Regime-Specific Validator — pure. Splits performance by market regime
// (trend/chop/high-vol/low-liquidity/news/session) and grades whether the
// edge is broad or only works under specific conditions.
//
// A strategy that only profits in trending markets is allowed to live, but
// must be labelled REGIME_SPECIFIC and the labels become trading
// restrictions ("ONLY_TRENDING_REGIMES") that downstream gates must honor.
// ═══════════════════════════════════════════════════════════════════════════

export type RegimeKey =
  | "TRENDING" | "CHOPPY" | "HIGH_VOL" | "LOW_LIQ" | "NEWS"
  | "SESSION_LONDON" | "SESSION_NY" | "SESSION_ASIA";

export interface RegimeStats {
  trades: number;
  expectancyR: number;
  winRate01: number;
}

export interface RegimeFitInput {
  byRegime: Partial<Record<RegimeKey, RegimeStats>>;
  minTradesPerRegime?: number;     // default 30
  minExpectancyPass?: number;      // default 0.05
}

export type RegimeLabel = "BROAD" | "REGIME_SPECIFIC" | "NARROW" | "INSUFFICIENT_DATA";

export interface RegimeFitResult {
  perRegime: Partial<Record<RegimeKey, {
    evaluated: boolean;
    passed: boolean;
    reason: string;
  }>>;
  regimesEvaluated: RegimeKey[];
  regimesPassing: RegimeKey[];
  regimeFit01: number;
  label: RegimeLabel;
  score01: number;
  restrictions: string[];
  reasons: string[];
}

const ALL_REGIMES: RegimeKey[] = [
  "TRENDING", "CHOPPY", "HIGH_VOL", "LOW_LIQ", "NEWS",
  "SESSION_LONDON", "SESSION_NY", "SESSION_ASIA",
];

export function assessRegimeFit(i: RegimeFitInput): RegimeFitResult {
  const minN = i.minTradesPerRegime ?? 30;
  const minE = i.minExpectancyPass ?? 0.05;
  const reasons: string[] = [];
  const restrictions: string[] = [];
  const perRegime: RegimeFitResult["perRegime"] = {};
  const evaluated: RegimeKey[] = [];
  const passing: RegimeKey[] = [];

  for (const k of ALL_REGIMES) {
    const s = i.byRegime[k];
    if (!s || s.trades < minN) {
      perRegime[k] = { evaluated: false, passed: false,
        reason: s ? `trades ${s.trades} < min ${minN}` : "no data" };
      continue;
    }
    evaluated.push(k);
    const passed = s.expectancyR >= minE;
    if (passed) passing.push(k);
    perRegime[k] = {
      evaluated: true, passed,
      reason: `n=${s.trades}, expectancy=${s.expectancyR.toFixed(3)}R, wr=${s.winRate01.toFixed(2)}`,
    };
  }

  const regimeFit01 = evaluated.length > 0 ? passing.length / evaluated.length : 0;

  let label: RegimeLabel;
  if (evaluated.length < 2) {
    label = "INSUFFICIENT_DATA";
    reasons.push(`only ${evaluated.length} regime(s) had enough data — cannot judge breadth`);
  } else if (regimeFit01 >= 0.75) {
    label = "BROAD";
  } else if (regimeFit01 >= 0.5) {
    label = "REGIME_SPECIFIC";
  } else if (passing.length >= 1) {
    label = "REGIME_SPECIFIC";
  } else {
    label = "NARROW";
  }

  if (label === "REGIME_SPECIFIC" || label === "NARROW") {
    for (const k of passing) restrictions.push(`ONLY_${k}`);
    if (passing.length === 0) restrictions.push("NO_REGIME_PASSES_GATES");
  }

  // Score: strong only if fit ≥ 0.75 AND ≥ 3 regimes evaluated.
  let score01 = regimeFit01;
  if (evaluated.length < 3) score01 *= 0.6;
  reasons.push(`${passing.length}/${evaluated.length} regime(s) passing → fit=${regimeFit01.toFixed(2)} (${label})`);

  return {
    perRegime, regimesEvaluated: evaluated, regimesPassing: passing,
    regimeFit01, label, score01, restrictions, reasons,
  };
}
