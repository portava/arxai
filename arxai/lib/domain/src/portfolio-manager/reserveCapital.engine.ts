import {
  type AccountRiskRules, type MarketRegime, clamp01,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Reserve Capital — compute the fraction of total risk budget held back
// during uncertain conditions. Inputs:
//
//   • account.minReserveFraction01            (floor)
//   • observed regime uncertainty             (raise reserve)
//   • observed account-wide drawdown          (raise reserve)
//   • count of frozen / decayed strategies    (raise reserve)
//
// Reserve is monotonically increasing in uncertainty and bounded to [floor,
// 0.95]. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ReserveInput {
  rules: AccountRiskRules;
  regimeUncertainty01: number;            // 0 = certain, 1 = chaotic
  accountDrawdownFraction01: number;      // 0 = no DD, 1 = at hard limit
  frozenStrategiesCount: number;
  decayedStrategiesCount: number;
  totalStrategiesCount: number;
  activeRegime: MarketRegime;
}

export interface ReserveOutput {
  reserveFraction01: number;
  reasons: string[];
}

export function computeReserveFraction(input: ReserveInput): ReserveOutput {
  const reasons: string[] = [];
  const floor = clamp01(input.rules.minReserveFraction01);
  let reserve = floor;

  // Uncertainty contributes up to +0.30.
  const uncContrib = clamp01(input.regimeUncertainty01) * 0.30;
  reserve += uncContrib;
  reasons.push(`regimeUncertainty +${uncContrib.toFixed(3)}`);

  // Account drawdown contributes up to +0.25.
  const ddContrib = clamp01(input.accountDrawdownFraction01) * 0.25;
  reserve += ddContrib;
  reasons.push(`accountDrawdown +${ddContrib.toFixed(3)}`);

  // Frozen / decayed share contributes up to +0.20 (combined).
  const denom = Math.max(1, input.totalStrategiesCount);
  const frozenShare = clamp01(input.frozenStrategiesCount / denom);
  const decayedShare = clamp01(input.decayedStrategiesCount / denom);
  const sysContrib = clamp01(frozenShare * 0.10 + decayedShare * 0.10);
  reserve += sysContrib;
  reasons.push(`frozen ${frozenShare.toFixed(2)} / decayed ${decayedShare.toFixed(2)} +${sysContrib.toFixed(3)}`);

  // CRASH regime forces an extra +0.20 minimum.
  if (input.activeRegime === "CRASH") {
    reserve = Math.max(reserve, floor + 0.20);
    reasons.push(`CRASH regime — reserve floor +0.20`);
  }

  // Final bounds: floor ≤ reserve ≤ 0.95 (always leave some deployable).
  const bounded = Math.min(0.95, Math.max(floor, reserve));
  if (bounded !== reserve) reasons.push(`bounded ${reserve.toFixed(3)} → ${bounded.toFixed(3)} (floor ${floor}, ceil 0.95)`);

  return { reserveFraction01: bounded, reasons };
}
