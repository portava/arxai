// Confluence Scoring Engine — weighted final confidence calculation

export interface ConfluenceInput {
  technicalScore: number;
  macroScore: number;
  sessionScore: number;
  strategyMatchScore: number;
  newsRiskPenalty: number;
  volatilityPenalty: number;
  spreadPenalty: number;
  category: "forex" | "indices" | "stocks" | "synthetic";
}

export interface ConfluenceBreakdown {
  technicalContrib: number;
  macroContrib: number;
  sessionContrib: number;
  strategyContrib: number;
  newsDeduction: number;
  volatilityDeduction: number;
  spreadDeduction: number;
  formula: string;
}

export interface ConfluenceResult {
  confidence: number;
  breakdown: ConfluenceBreakdown;
}

export function computeConfidence(input: ConfluenceInput): ConfluenceResult {
  const { technicalScore, macroScore, sessionScore, strategyMatchScore, newsRiskPenalty, volatilityPenalty, spreadPenalty, category } = input;
  let confidence: number;
  let formula: string;
  let technicalContrib: number;
  let macroContrib: number;
  let sessionContrib: number;
  let strategyContrib: number;

  if (category === "synthetic") {
    // Synthetic: no macro, heavier on technical + strategy match
    technicalContrib = technicalScore * 0.65;
    macroContrib = 0;
    sessionContrib = sessionScore * 0.05;
    strategyContrib = strategyMatchScore * 0.25;
    formula = "technicalScore×0.65 + strategyMatch×0.25 + session×0.05 − penalties";
    confidence = technicalContrib + sessionContrib + strategyContrib - volatilityPenalty - spreadPenalty;
  } else {
    // Forex, indices, stocks: full macro-weighted formula
    technicalContrib = technicalScore * 0.45;
    macroContrib = macroScore * 0.20;
    sessionContrib = sessionScore * 0.10;
    strategyContrib = strategyMatchScore * 0.15;
    formula = "technicalScore×0.45 + macro×0.20 + session×0.10 + strategy×0.15 − penalties";
    confidence = technicalContrib + macroContrib + sessionContrib + strategyContrib - newsRiskPenalty - volatilityPenalty - spreadPenalty;
  }

  // Clamp confidence to [5, 95]
  const clamped = Math.max(5, Math.min(95, Math.round(confidence)));

  return {
    confidence: clamped,
    breakdown: {
      technicalContrib: Math.round(technicalContrib * 10) / 10,
      macroContrib: Math.round(macroContrib * 10) / 10,
      sessionContrib: Math.round(sessionContrib * 10) / 10,
      strategyContrib: Math.round(strategyContrib * 10) / 10,
      newsDeduction: newsRiskPenalty,
      volatilityDeduction: volatilityPenalty,
      spreadDeduction: spreadPenalty,
      formula,
    },
  };
}

export function computeNewsRiskPenalty(riskLevel: string): number {
  switch (riskLevel) {
    case "Critical": return 40;
    case "High": return 20;
    case "Medium": return 8;
    default: return 0;
  }
}

export function computeVolatilityPenalty(atrState: string, category: string): number {
  if (category === "synthetic") {
    // Synthetics expect high volatility — only penalise extreme
    return atrState === "Expanding" ? 3 : 0;
  }
  switch (atrState) {
    case "Expanding": return 5; // Extra volatility = extra risk
    case "Contracting": return 2; // Low liquidity
    default: return 0;
  }
}

export function computeSpreadPenalty(category: string, riskLevel: string): number {
  // Higher risk = wider spread assumption
  switch (riskLevel) {
    case "Very High": return 8;
    case "High": return 5;
    case "Medium-High": return 3;
    default: return 0;
  }
}

export function computeStrategyMatchScore(
  structure: string,
  emaAlignment: string,
  liquiditySweep: string,
  rsiState: string,
  volatilityExpansion: boolean,
  session: string,
): { score: number; bestStrategy: string } {
  const scores: Array<{ name: string; score: number }> = [];

  // Trend Continuation
  if ((emaAlignment === "Full Bull" || emaAlignment === "Full Bear") && (rsiState === "Bullish" || rsiState === "Bearish")) {
    scores.push({ name: "Trend Continuation", score: 85 });
  }

  // Break of Structure
  if (structure === "Higher Highs" || structure === "Lower Lows") {
    scores.push({ name: "Break of Structure", score: 75 });
  }

  // Liquidity Sweep Reversal
  if (liquiditySweep !== "None") {
    scores.push({ name: "Liquidity Sweep Reversal", score: 80 });
  }

  // Volatility Expansion
  if (volatilityExpansion) {
    scores.push({ name: "Volatility Expansion", score: 72 });
  }

  // Pullback Continuation
  if ((structure === "Higher Highs" || structure === "Lower Lows") && (rsiState === "Neutral" || rsiState === "Bearish" && emaAlignment.includes("Bull") || rsiState === "Bullish" && emaAlignment.includes("Bear"))) {
    scores.push({ name: "Pullback Continuation", score: 78 });
  }

  // Mean Reversion
  if (structure === "Range" && (rsiState === "Overbought" || rsiState === "Oversold")) {
    scores.push({ name: "Mean Reversion", score: 70 });
  }

  // Session Breakout
  if ((session === "London" || session === "London/NY Overlap") && structure === "Breakout") {
    scores.push({ name: "Session Breakout", score: 82 });
  }

  if (scores.length === 0) {
    return { score: 30, bestStrategy: "No Trade Filter" };
  }

  scores.sort((a, b) => b.score - a.score);
  return { score: scores[0].score, bestStrategy: scores[0].name };
}
