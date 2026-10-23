import {
  type Hypothesis, type HypothesisScore, RESEARCH_WEIGHTS,
} from "./researchAi.types";

export interface ScoringContext {
  currentMarketPhase: string;           // matches market-state's phase enum string-wise
  existingStrategyKinds: string[];      // for novelty calc
  existingStrategyTimeframes: string[];
  regimeEdgeMap?: Partial<Record<string, number>>; // optional: kind → known historical edge in this regime
}

// scoreHypothesis — pure scoring of a single hypothesis. Inputs:
//   plausibility = 0.5 baseline + small bump if regimeEdgeMap shows positive edge
//                                              for this kind in current regime
//   novelty      = 1 − (existingMatches / max(1, existingTotal)) capped 0..1
//   fit          = 1.0 if kind matches current phase keywords; 0.5 default
// Composite = weighted blend (0.50 plausibility, 0.20 novelty, 0.30 fit)
export function scoreHypothesis(h: Hypothesis, ctx: ScoringContext): HypothesisScore {
  const W = RESEARCH_WEIGHTS;
  const reasons: string[] = [];

  let plausibility = 0.50;
  if (ctx.regimeEdgeMap && ctx.regimeEdgeMap[h.kind] !== undefined) {
    const edge = ctx.regimeEdgeMap[h.kind] ?? 0;
    plausibility = Math.max(0, Math.min(1, 0.5 + edge));
    reasons.push(`regime edge ${edge.toFixed(2)} for ${h.kind} → plausibility ${plausibility.toFixed(2)}`);
  } else {
    reasons.push(`no regime edge data — plausibility default 0.50`);
  }

  const matches = ctx.existingStrategyKinds.filter((k) => k === h.kind).length;
  const novelty = ctx.existingStrategyKinds.length === 0
    ? 1.0
    : Math.max(0, Math.min(1, 1 - matches / ctx.existingStrategyKinds.length));
  reasons.push(`${matches}/${ctx.existingStrategyKinds.length} existing strategies match kind → novelty ${novelty.toFixed(2)}`);

  const phaseMatches: Record<string, string[]> = {
    TREND_FOLLOWING:        ["TREND_UP", "TREND_DOWN"],
    MEAN_REVERSION:         ["RANGE", "ACCUMULATION", "DISTRIBUTION"],
    BREAKOUT:               ["BREAKOUT", "VOLATILITY_EXPANSION"],
    LIQUIDITY_SWEEP:        ["RANGE", "DISTRIBUTION", "ACCUMULATION"],
    VOLATILITY_EXPANSION:   ["VOLATILITY_EXPANSION", "BREAKOUT"],
    CARRY:                  ["TREND_UP", "TREND_DOWN"],
    NEWS_DRIVEN:            ["VOLATILITY_EXPANSION"],
    STRUCTURAL:             [],
    OTHER:                  [],
  };
  const fitMatch = (phaseMatches[h.kind] ?? []).includes(ctx.currentMarketPhase);
  const fit = fitMatch ? 1.0 : 0.5;
  reasons.push(`kind ${h.kind} ${fitMatch ? "fits" : "neutral for"} phase ${ctx.currentMarketPhase} → fit ${fit.toFixed(2)}`);

  const composite = plausibility * W.plausibility + novelty * W.novelty + fit * W.fit;
  return {
    hypothesisId: h.hypothesisId,
    plausibility01: plausibility, novelty01: novelty, fit01: fit, composite01: composite,
    reasons: [...reasons, `composite ${composite.toFixed(3)}`],
  };
}

export function rankHypotheses(scored: HypothesisScore[]): HypothesisScore[] {
  return [...scored].sort((a, b) => b.composite01 - a.composite01);
}
