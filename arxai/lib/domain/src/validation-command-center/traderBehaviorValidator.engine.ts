// ═══════════════════════════════════════════════════════════════════════════
// Trader Behavior Validator — pure. Asks: would the strategy survive the
// trader running it? Real human (or AI-with-overrides) behavior degrades
// edges via tilt-after-loss, override-driven decisions, overtrading, and
// discipline collapse under cognitive load.
//
// Restrictions:
//   • after-loss expectancy < 50% baseline   → REQUIRES_LOSS_COOLDOWN
//   • after-override expectancy < 50% base   → DISALLOW_MANUAL_OVERRIDES
//   • overtrading score > 0.7                → ENFORCE_DAILY_TRADE_CAP
//   • cognitive sensitivity > 0.7            → REQUIRES_COGNITIVE_GATE
// ═══════════════════════════════════════════════════════════════════════════

export interface TraderBehaviorInput {
  baselineExpectancyR: number;
  afterLossExpectancyR: number;
  afterOverrideExpectancyR: number;
  overtradingScore01: number;        // 0=fine, 1=severe overtrading
  disciplineImpactScore01: number;   // 0=no impact, 1=results destroyed
  cognitiveRiskSensitivity01: number;// 0=insensitive, 1=very sensitive
}
export interface TraderBehaviorResult {
  baselineExpectancyR: number;
  afterLossDegradationPct01: number;
  afterOverrideDegradationPct01: number;
  score01: number;
  restrictions: string[];
  reasons: string[];
}

function degradationPct(baseline: number, perturbed: number): number {
  if (baseline <= 0) return 1;
  return Math.min(1, Math.max(0, (baseline - perturbed) / baseline));
}

export function assessTraderBehaviorSafety(i: TraderBehaviorInput): TraderBehaviorResult {
  const reasons: string[] = [];
  const restrictions: string[] = [];

  const lossDeg  = degradationPct(i.baselineExpectancyR, i.afterLossExpectancyR);
  const ovDeg    = degradationPct(i.baselineExpectancyR, i.afterOverrideExpectancyR);

  if (lossDeg > 0.5) restrictions.push("REQUIRES_LOSS_COOLDOWN");
  if (ovDeg > 0.5)   restrictions.push("DISALLOW_MANUAL_OVERRIDES");
  if (i.overtradingScore01 > 0.7) restrictions.push("ENFORCE_DAILY_TRADE_CAP");
  if (i.cognitiveRiskSensitivity01 > 0.7) restrictions.push("REQUIRES_COGNITIVE_GATE");
  if (i.disciplineImpactScore01 > 0.7) restrictions.push("REQUIRES_DISCIPLINE_COACH_GATE");

  // Composite penalty: each adverse signal pulls score down.
  const adverse = [
    lossDeg, ovDeg,
    i.overtradingScore01, i.disciplineImpactScore01,
    i.cognitiveRiskSensitivity01,
  ];
  const meanAdverse = adverse.reduce((a, b) => a + b, 0) / adverse.length;
  const score01 = Math.max(0, Math.min(1, 1 - meanAdverse));

  reasons.push(`after-loss expectancy degradation = ${(lossDeg * 100).toFixed(1)}%`);
  reasons.push(`after-override degradation = ${(ovDeg * 100).toFixed(1)}%`);
  reasons.push(`overtrading=${i.overtradingScore01.toFixed(2)}, discipline-impact=${i.disciplineImpactScore01.toFixed(2)}, cog-sensitivity=${i.cognitiveRiskSensitivity01.toFixed(2)}`);
  if (restrictions.length > 0) reasons.push(`restrictions: ${restrictions.join(", ")}`);

  return {
    baselineExpectancyR: i.baselineExpectancyR,
    afterLossDegradationPct01: lossDeg,
    afterOverrideDegradationPct01: ovDeg,
    score01, restrictions, reasons,
  };
}
