import {
  type AdaptiveAggression,
  type AggressionLevel,
  type ConvictionReport,
  type FatigueState,
  type MarketPersonality,
  LEVEL_MULTIPLIER_PUBLIC,
} from "./_levelMultiplier";
import {
  type AggressionLimitDecision,
  AGGRESSION_RANK,
} from "./governance.types";

// ═══════════════════════════════════════════════════════════════════════════
// deriveAggressionLimit — conviction CONTROLS aggression.
//
// The adaptive-aggression engine already produces a recommended level
// based on conviction calibration, expectancy, market, and fatigue. This
// engine produces the AGGRESSION CAP that downstream sizing must respect:
//
//   • Cap = min(adaptive-recommendation, conviction-implied-ceiling,
//               market-implied-ceiling, fatigue-implied-ceiling)
//   • Conviction calibration ≥ 0.80                → ceiling = MAX
//   • Conviction 0.60–0.80                         → ceiling = ELEVATED
//   • Conviction 0.40–0.60                         → ceiling = STANDARD
//   • Conviction < 0.40                            → ceiling = CONSERVATIVE
//   • Frenzy/noisy market personality              → ceiling ≤ STANDARD
//   • Fatigue forceCooldown                        → ceiling = CONSERVATIVE
//   • Output never exceeds the adaptive recommendation; it can only
//     restrict it further.
//
// Note: a "good losing trade" leaves conviction calibration high (the
// expressed confidence was honest about its win-rate). It must NOT pull
// the ceiling down. A "bad winning trade" lowers calibration over time
// (overconfident bands accumulate), which DOES pull the ceiling down.
// ═══════════════════════════════════════════════════════════════════════════

export interface DeriveAggressionLimitInput {
  readonly conviction: ConvictionReport;
  readonly aggression: AdaptiveAggression;
  readonly market: MarketPersonality;
  readonly fatigue: FatigueState;
}

const ORDERED: ReadonlyArray<AggressionLevel> = [
  "CONSERVATIVE", "STANDARD", "ELEVATED", "MAX",
];

function clampToCeiling(
  candidate: AggressionLevel, ceiling: AggressionLevel,
): AggressionLevel {
  return AGGRESSION_RANK[candidate] <= AGGRESSION_RANK[ceiling]
    ? candidate
    : ceiling;
}
function minOf(...levels: AggressionLevel[]): AggressionLevel {
  return levels.reduce((a, b) => (AGGRESSION_RANK[a] <= AGGRESSION_RANK[b] ? a : b));
}

function convictionCeiling(c: ConvictionReport): AggressionLevel {
  const cal = c.overallCalibration01;
  if (cal >= 0.80) return "MAX";
  if (cal >= 0.60) return "ELEVATED";
  if (cal >= 0.40) return "STANDARD";
  return "CONSERVATIVE";
}
function marketCeiling(m: MarketPersonality): AggressionLevel {
  if (m.frenzy01 >= 0.5 || m.noisy01 >= 0.5) return "STANDARD";
  return "MAX";
}
function fatigueCeiling(f: FatigueState): AggressionLevel {
  if (f.forceCooldown) return "CONSERVATIVE";
  if (f.fatigueScore01 >= 0.6) return "STANDARD";
  return "MAX";
}

export function deriveAggressionLimit(
  input: DeriveAggressionLimitInput,
): AggressionLimitDecision {
  const reasons: string[] = [];
  const cConv = convictionCeiling(input.conviction);
  const cMkt = marketCeiling(input.market);
  const cFat = fatigueCeiling(input.fatigue);

  const ceiling = minOf(cConv, cMkt, cFat);
  const recommendedAggression = input.aggression.level;
  const maxLevel = clampToCeiling(recommendedAggression, ceiling);

  reasons.push(
    `conviction ceiling=${cConv} (cal=${input.conviction.overallCalibration01.toFixed(2)})`,
  );
  reasons.push(
    `market ceiling=${cMkt} (frenzy=${input.market.frenzy01.toFixed(2)}, noisy=${input.market.noisy01.toFixed(2)})`,
  );
  reasons.push(
    `fatigue ceiling=${cFat} (score=${input.fatigue.fatigueScore01.toFixed(2)}, cooldown=${input.fatigue.forceCooldown})`,
  );
  reasons.push(`adaptive recommendation=${recommendedAggression}`);
  reasons.push(`final cap=${maxLevel}`);

  // The cap MULTIPLIER is the LEVEL_MULTIPLIER for the cap, but never
  // greater than the adaptive engine's own multiplier (so a cooldown
  // multiplier of 0 still wins).
  const capMultiplier = Math.min(
    LEVEL_MULTIPLIER_PUBLIC[maxLevel],
    input.aggression.multiplier,
  );

  return {
    maxAggressionLevel: maxLevel,
    recommendedAggressionLevel: recommendedAggression,
    maxAggressionMultiplier: capMultiplier,
    reasons,
  };
}

// Re-exported for engines that share the same ordering.
export { ORDERED as AGGRESSION_ORDER };
