import {
  type DecisionRecord, type ExpectancyMetrics, type MarketPersonality,
  type PatienceMetrics, clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// No-Trade Quality — score the QUALITY of a NO_TRADE / BLOCKED decision.
//
// Core stance: restraint is a real decision. A NO_TRADE that avoided a
// blow-up is a high-quality decision; a NO_TRADE that missed a clean
// disciplined win is a regretted-restraint event (still not punished as
// hard as undisciplined losses, but recorded).
//
//   counterfactualSignal = if counterfactualR <= 0  → 1.0  (vindicated)
//                          else                      → tanh-scaled penalty
//   marketPenaltyAvoided = blend of frenzy/noisy → restraint reward
//   selectivityReward    = patience.selectivityScore01
//   negativeExpectancyReward = 1 − expectancyQuality01
//
//   score = clamp01( w1·cfSignal + w2·marketPenaltyAvoided
//                   + w3·selectivity + w4·negativeExpectancyReward )
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_NO_TRADE_TUNING = {
  W_COUNTERFACTUAL: 0.50,
  W_MARKET_AVOID:   0.20,
  W_SELECTIVITY:    0.15,
  W_NEG_EXPECTANCY: 0.15,
  REINFORCE_AT: 0.65,
} as const;
export type NoTradeTuning = typeof DEFAULT_NO_TRADE_TUNING;

export type NoTradeClassification =
  | "VINDICATED_RESTRAINT"   // counterfactualR ≤ 0 — avoided a real loss
  | "GOOD_RESTRAINT"         // ambiguous market context favoured waiting
  | "NEUTRAL_RESTRAINT"      // counterfactual roughly flat
  | "REGRETTED_RESTRAINT";   // counterfactualR > 0 — missed a real win

export interface NoTradeQualityScore {
  decisionId: string;
  classification: NoTradeClassification;
  qualityScore01: number;
  reinforce: boolean;
  reasons: string[];
}

export interface NoTradeQualityInput {
  decision: DecisionRecord;       // must be NO_TRADE or BLOCKED
  counterfactualR?: number;       // realised R if the trade HAD been taken
  market: MarketPersonality;
  patience: PatienceMetrics;
  expectancy: ExpectancyMetrics;
  tuning?: NoTradeTuning;
}

export function scoreNoTradeQuality(input: NoTradeQualityInput): NoTradeQualityScore {
  const t = input.tuning ?? DEFAULT_NO_TRADE_TUNING;
  const reasons: string[] = [];
  const d = input.decision;

  if (d.kind !== "NO_TRADE" && d.kind !== "BLOCKED") {
    reasons.push(`decision.kind=${d.kind} is not a restraint decision — score=0`);
    return {
      decisionId: d.decisionId,
      classification: "NEUTRAL_RESTRAINT",
      qualityScore01: 0, reinforce: false, reasons,
    };
  }

  // Counterfactual signal: ≤0 → fully vindicated; >0 → linear penalty
  // saturating around 2R.
  const cf = input.counterfactualR;
  let cfSignal: number;
  let classification: NoTradeClassification;
  if (typeof cf !== "number") {
    cfSignal = 0.6;  // unknown — slight reward (default-safe restraint)
    classification = "GOOD_RESTRAINT";
    reasons.push(`no counterfactual supplied — neutral-good baseline 0.60`);
  } else if (cf <= -0.25) {
    cfSignal = 1.0;
    classification = "VINDICATED_RESTRAINT";
    reasons.push(`counterfactualR ${cf.toFixed(2)} ≤ -0.25 — VINDICATED`);
  } else if (cf <= 0.10) {
    cfSignal = 0.7;
    classification = "NEUTRAL_RESTRAINT";
    reasons.push(`counterfactualR ${cf.toFixed(2)} flat — neutral restraint`);
  } else {
    cfSignal = clamp01(1 - Math.tanh(cf / 2));   // 0.5R→0.76, 1R→0.54, 2R→0.24
    classification = "REGRETTED_RESTRAINT";
    reasons.push(`counterfactualR ${cf.toFixed(2)} > 0 — REGRETTED restraint, partial credit ${cfSignal.toFixed(2)}`);
  }

  // Market-avoid reward: high frenzy or noisy market makes restraint
  // structurally good even with no counterfactual proof.
  const marketAvoid = clamp01(0.5 * input.market.frenzy01 + 0.5 * input.market.noisy01);

  // Selectivity reward — already-selective systems are practising
  // patience, not paralysis.
  const selectivity = clamp01(input.patience.selectivityScore01);

  // Negative-expectancy reward — restraint at a time when E[R] is poor
  // is highly rational.
  const negExp = clamp01(1 - input.expectancy.expectancyQuality01);

  const qualityScore01 = clamp01(
      t.W_COUNTERFACTUAL * cfSignal
    + t.W_MARKET_AVOID   * marketAvoid
    + t.W_SELECTIVITY    * selectivity
    + t.W_NEG_EXPECTANCY * negExp,
  );
  reasons.push(
    `cf ${cfSignal.toFixed(2)} · marketAvoid ${marketAvoid.toFixed(2)} · ` +
    `selectivity ${selectivity.toFixed(2)} · negExp ${negExp.toFixed(2)} → ${qualityScore01.toFixed(3)}`);

  const reinforce = qualityScore01 >= t.REINFORCE_AT
    && classification !== "REGRETTED_RESTRAINT";

  return { decisionId: d.decisionId, classification, qualityScore01, reinforce, reasons };
}
