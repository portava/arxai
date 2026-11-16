// ═══════════════════════════════════════════════════════════════════════════
// Execution Reality Validator — pure. Translates clean backtest expectancy
// into the expectancy a trader would actually realise after slippage,
// spreads, latency, partial fills, and broker reliability are accounted for.
//
// Restrictions get attached when realism gates fail:
//   • implementation shortfall > 50% of expectancy → BROKER_DEGRADATION_RISK
//   • fill probability < 0.85                       → LIMIT_TO_LIQUID_HOURS
//   • broker reliability < 0.9                      → REQUIRES_REDUNDANT_BROKER
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecutionRealityInput {
  expectancyR: number;
  slippageImpactR: number;
  spreadImpactR: number;
  latencyImpactR: number;
  fillProbability01: number;
  implementationShortfallR: number;
  brokerReliability01: number;
}
export interface ExecutionRealityResult {
  netExpectancyR: number;
  totalImpactR: number;
  shortfallPctOfExpectancy01: number;
  fillProbability01: number;
  brokerReliability01: number;
  score01: number;
  restrictions: string[];
  reasons: string[];
}

export function assessExecutionReality(i: ExecutionRealityInput): ExecutionRealityResult {
  const reasons: string[] = [];
  const restrictions: string[] = [];
  const totalImpact = i.slippageImpactR + i.spreadImpactR + i.latencyImpactR;
  const netExpectancy = i.expectancyR - totalImpact;

  const shortfallPct = i.expectancyR > 0
    ? Math.min(1, Math.max(0, i.implementationShortfallR / i.expectancyR))
    : 1;

  if (shortfallPct > 0.5) restrictions.push("BROKER_DEGRADATION_RISK");
  if (i.fillProbability01 < 0.85) restrictions.push("LIMIT_TO_LIQUID_HOURS");
  if (i.brokerReliability01 < 0.9) restrictions.push("REQUIRES_REDUNDANT_BROKER");
  if (netExpectancy <= 0) restrictions.push("NEGATIVE_NET_EXPECTANCY_AFTER_EXECUTION");

  // Score combines: positive net expectancy ratio + fill prob + broker rel
  // − shortfall penalty.
  const netRatio = i.expectancyR > 0
    ? Math.max(0, Math.min(1, netExpectancy / i.expectancyR))
    : 0;
  const score01 = Math.max(0, Math.min(1,
    0.5 * netRatio
    + 0.25 * Math.min(1, Math.max(0, i.fillProbability01))
    + 0.25 * Math.min(1, Math.max(0, i.brokerReliability01))
    - 0.3 * shortfallPct));

  reasons.push(`net expectancy after execution = ${netExpectancy.toFixed(3)}R (was ${i.expectancyR.toFixed(3)}R)`);
  reasons.push(`implementation shortfall = ${(shortfallPct * 100).toFixed(1)}% of expectancy`);
  reasons.push(`fill prob ${i.fillProbability01.toFixed(2)}, broker rel ${i.brokerReliability01.toFixed(2)}`);
  if (restrictions.length > 0) reasons.push(`restrictions: ${restrictions.join(", ")}`);

  return {
    netExpectancyR: netExpectancy,
    totalImpactR: totalImpact,
    shortfallPctOfExpectancy01: shortfallPct,
    fillProbability01: i.fillProbability01,
    brokerReliability01: i.brokerReliability01,
    score01, restrictions, reasons,
  };
}
