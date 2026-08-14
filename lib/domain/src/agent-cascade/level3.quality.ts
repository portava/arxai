import {
  type AgentCascadeInput, type Level3Result, type QualityVerdict,
  AGENT_CASCADE_THRESHOLDS,
} from "./agentCascade.types";

// ── Level 3 — Quality Agents ──────────────────────────────────────────────
//
// Each agent scores the quality of the proposed setup 0..100. The level
// runner averages scores and derives a confidence multiplier in
// [minMultiplier, maxMultiplier].

// ── Entry Precision Agent ─────────────────────────────────────────────────
//
// Scores the entry-price quality from EMA confluence and proximity to a
// recent swing reference. Tight entries near structure score high; loose
// entries far from any reference score low.
export function evaluateEntryPrecisionAgent(input: AgentCascadeInput): QualityVerdict {
  const reasons: string[] = [];
  let score = 50;

  // EMA confluence — 0..1 → up to +30
  const confBoost = input.priceContext.emaConfluence01 * 30;
  score += confBoost;
  reasons.push(`+${confBoost.toFixed(0)} from EMA confluence ${input.priceContext.emaConfluence01.toFixed(2)}`);

  // Proximity to swing — closer = better. ≤ 3 pips = +20; ≤ 10 = +10; > 30 = -15.
  const px = input.priceContext.pipsToNearestSwing;
  let proximityAdj = 0;
  if (px <= 3)       { proximityAdj = 20;  reasons.push(`+20 — entry within 3p of swing reference`); }
  else if (px <= 10) { proximityAdj = 10;  reasons.push(`+10 — entry within 10p of swing reference`); }
  else if (px > 30)  { proximityAdj = -15; reasons.push(`-15 — entry ${px.toFixed(0)}p from nearest swing (loose)`); }
  score += proximityAdj;

  score = clamp(score, 0, 100);
  return { agentId: "L3.PRECISION", agentName: "Entry Precision Agent", qualityScore: score, reasons };
}

// ── Session Agent ─────────────────────────────────────────────────────────
//
// Scores from session match. Trading in a symbol's preferred sessions
// scores high; off-hours scores low. Symbols that prefer no specific
// sessions get a neutral score.
export function evaluateSessionAgent(input: AgentCascadeInput): QualityVerdict {
  const reasons: string[] = [];
  const cur = input.session.current;
  const prefs = input.session.symbolPreferredSessions;
  let score: number;

  if (prefs.length === 0) {
    score = 60;
    reasons.push(`symbol has no preferred sessions — neutral 60`);
  } else if (prefs.includes(cur)) {
    score = 85;
    reasons.push(`current session ${cur} is in preferred set — quality 85`);
  } else if (cur === "OFF_HOURS") {
    score = 25;
    reasons.push(`OFF_HOURS — quality 25`);
  } else {
    score = 45;
    reasons.push(`current session ${cur} not preferred (prefers ${prefs.join(",")}) — quality 45`);
  }

  return { agentId: "L3.SESSION", agentName: "Session Agent", qualityScore: score, reasons };
}

// ── Volatility Agent ──────────────────────────────────────────────────────
//
// Scores from the volatility regime. Mid-range vol = high quality
// (predictable); extremes (too quiet or too chaotic) = low quality.
export function evaluateVolatilityAgent(input: AgentCascadeInput): QualityVerdict {
  const reasons: string[] = [];
  const v = input.volatility;
  let score: number;

  if (v.historicalP10 <= 0 || v.historicalP90 <= 0 || v.historicalMedian <= 0) {
    score = 50;
    reasons.push(`volatility baseline not recorded — neutral 50`);
  } else if (v.current < v.historicalP10) {
    score = 30;
    reasons.push(`vol ${v.current.toFixed(4)} < P10 ${v.historicalP10.toFixed(4)} — too quiet, score 30`);
  } else if (v.current > v.historicalP90) {
    score = 25;
    reasons.push(`vol ${v.current.toFixed(4)} > P90 ${v.historicalP90.toFixed(4)} — too chaotic, score 25`);
  } else {
    // Closer to median = higher score; map distance ratio to 80..95.
    const dist = Math.abs(v.current - v.historicalMedian)
      / Math.max(v.historicalP90 - v.historicalP10, 1e-9);
    score = clamp(95 - dist * 15, 80, 95);
    reasons.push(`vol ${v.current.toFixed(4)} mid-range (median ${v.historicalMedian.toFixed(4)}) — quality ${score.toFixed(0)}`);
  }

  return { agentId: "L3.VOL", agentName: "Volatility Agent", qualityScore: score, reasons };
}

// ── Historical Match Agent ────────────────────────────────────────────────
//
// Scores from the win-rate of similar past setups, weighted by sample size
// and similarity strength. Single-match populations are heavily discounted.
export function evaluateHistoricalMatchAgent(input: AgentCascadeInput): QualityVerdict {
  const reasons: string[] = [];
  const h = input.historical;

  if (h.matchCount === 0) {
    reasons.push(`no historical matches — neutral 50`);
    return { agentId: "L3.HIST", agentName: "Historical Match Agent", qualityScore: 50, reasons };
  }

  // Sample-size confidence (Wilson-ish, simplified): grow with sqrt(matches),
  // saturate around 30 matches. With < 5 matches, statistic is unreliable.
  const sampleConfidence01 = Math.min(Math.sqrt(h.matchCount) / Math.sqrt(30), 1);
  // Similarity discount: low similarity = treat the population as less trustworthy.
  const trust01 = sampleConfidence01 * h.averageSimilarity01;

  // Pure win-rate score: 0..100. With low trust, blend toward 50 (neutral).
  const winRateScore = h.winRate01 * 100;
  const score = winRateScore * trust01 + 50 * (1 - trust01);

  reasons.push(
    `${h.matchCount} historical matches @ ${(h.winRate01 * 100).toFixed(0)}% win, ` +
    `avg ${h.averagePnlR.toFixed(2)}R, similarity ${h.averageSimilarity01.toFixed(2)} — ` +
    `quality ${score.toFixed(0)} (trust ${trust01.toFixed(2)})`,
  );

  return { agentId: "L3.HIST", agentName: "Historical Match Agent", qualityScore: clamp(score, 0, 100), reasons };
}

// ── Level runner ──────────────────────────────────────────────────────────
//
// Averages all four quality scores, then maps the average to a confidence
// multiplier in [minMultiplier, maxMultiplier]. Multiplier is a smooth
// piecewise-linear: averageQuality 0 → minMultiplier; 100 → maxMultiplier.
export function runLevel3(input: AgentCascadeInput): Level3Result {
  const T = AGENT_CASCADE_THRESHOLDS.level3;
  const verdicts = [
    evaluateEntryPrecisionAgent(input),
    evaluateSessionAgent(input),
    evaluateVolatilityAgent(input),
    evaluateHistoricalMatchAgent(input),
  ];
  const averageQuality = verdicts.reduce((s, v) => s + v.qualityScore, 0) / verdicts.length;
  const confidenceMultiplier = T.minMultiplier
    + (T.maxMultiplier - T.minMultiplier) * (averageQuality / 100);
  return { verdicts, averageQuality, confidenceMultiplier };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
