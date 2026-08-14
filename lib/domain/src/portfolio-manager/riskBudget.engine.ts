import {
  type AccountRiskRules, type RiskBudget, clamp01, clampNonNegative,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Risk Budget — convert account equity + risk rules + reserve fraction
// into deployable / reserve risk in R units (using account equity as
// 1R := equity × maxAccountRiskFraction). Pure. Never exceeds the
// account-wide cap (the global clamp).
// ═══════════════════════════════════════════════════════════════════════════

export interface RiskBudgetInput {
  rules: AccountRiskRules;
  reserveFraction01: number;
}

export function computeRiskBudget(input: RiskBudgetInput): RiskBudget {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const r = input.rules;

  // Total risk budget in R units. We treat the account-cap × equity as the
  // total addressable risk (all internal caps are fractions of this).
  const totalR = clampNonNegative(r.accountEquity * r.maxAccountRiskFraction01);
  reasons.push(`totalRiskBudgetR = equity ${r.accountEquity} × maxAccountRisk ${r.maxAccountRiskFraction01} = ${totalR.toFixed(2)}`);

  const reserveFrac = clamp01(input.reserveFraction01);
  if (reserveFrac < r.minReserveFraction01 - 1e-9) {
    blockers.push(`reserveFraction ${reserveFrac.toFixed(3)} < minReserveFraction ${r.minReserveFraction01}`);
  }

  const reserveR = clampNonNegative(totalR * reserveFrac);
  const deployableR = clampNonNegative(totalR - reserveR);
  reasons.push(`reserveR ${reserveR.toFixed(2)} (frac ${reserveFrac.toFixed(2)}) · deployableR ${deployableR.toFixed(2)}`);

  // Per-bucket caps are fractions of the TOTAL risk budget (not of
  // deployable) — this preserves the global invariant that no single
  // bucket can exceed its account-rule fraction even after reserve maths.
  const perStrategyCapR = clampNonNegative(totalR * r.maxPerStrategyRiskFraction01);
  const perSymbolCapR   = clampNonNegative(totalR * r.maxPerSymbolRiskFraction01);
  const perSessionCapR  = clampNonNegative(totalR * r.maxPerSessionRiskFraction01);

  // Final invariant guard: caps must not exceed deployable. If a cap is
  // higher than what's actually deployable we lower it (still within the
  // account rule), and surface as a reason.
  const adjStrat = Math.min(perStrategyCapR, deployableR);
  const adjSym   = Math.min(perSymbolCapR,   deployableR);
  const adjSess  = Math.min(perSessionCapR,  deployableR);
  if (adjStrat !== perStrategyCapR) reasons.push(`perStrategyCap reduced from ${perStrategyCapR.toFixed(2)} to deployable ${adjStrat.toFixed(2)}`);
  if (adjSym   !== perSymbolCapR)   reasons.push(`perSymbolCap reduced from ${perSymbolCapR.toFixed(2)} to deployable ${adjSym.toFixed(2)}`);
  if (adjSess  !== perSessionCapR)  reasons.push(`perSessionCap reduced from ${perSessionCapR.toFixed(2)} to deployable ${adjSess.toFixed(2)}`);

  return {
    totalRiskBudgetR: totalR,
    deployableR, reserveR,
    perStrategyCapR: adjStrat,
    perSymbolCapR:   adjSym,
    perSessionCapR:  adjSess,
    reserveFraction01: reserveFrac,
    reasons, blockers,
  };
}
