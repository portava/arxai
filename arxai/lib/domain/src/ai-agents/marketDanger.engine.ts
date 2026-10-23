import type { MarketDangerInput, MarketDangerResult } from "./aiAgents.types";

const OVERRIDE_THRESHOLD = 70;  // dangerScore ≥ 70 → consensus must downgrade to BLOCK

export function evaluateMarketDanger(input: MarketDangerInput): MarketDangerResult {
  const reasons: string[] = [];
  let score = 0;

  // Volatility percentile contribution (0..40)
  if (input.volatilityPercentile > 95)      { score += 40; reasons.push(`ATR p${input.volatilityPercentile.toFixed(0)} — extreme`); }
  else if (input.volatilityPercentile > 85) { score += 25; reasons.push(`ATR p${input.volatilityPercentile.toFixed(0)} — elevated`); }
  else if (input.volatilityPercentile > 75) { score += 15; reasons.push(`ATR p${input.volatilityPercentile.toFixed(0)} — above normal`); }

  // Spread blowout (0..25)
  if (input.spreadVsAvg > 3)        { score += 25; reasons.push(`spread ${input.spreadVsAvg.toFixed(1)}× normal — blowout`); }
  else if (input.spreadVsAvg > 2)   { score += 15; reasons.push(`spread ${input.spreadVsAvg.toFixed(1)}× normal — elevated`); }
  else if (input.spreadVsAvg > 1.5) { score += 8; }

  // Liquidity collapse (0..20)
  if (input.liquidity < 20)      { score += 20; reasons.push(`liquidity ${input.liquidity.toFixed(0)} — collapsed`); }
  else if (input.liquidity < 35) { score += 10; reasons.push(`liquidity ${input.liquidity.toFixed(0)} — thin`); }

  // News window (0..10) — caller signals via newsActive
  if (input.newsActive) { score += 10; reasons.push("news window active"); }

  // Liquidity sweep against signal already happened (0..10)
  if (input.recentSweepConflict) { score += 10; reasons.push("recent sweep conflicts with signal"); }

  // Broker stale (0..15) — physical execution risk
  if (input.brokerStale) { score += 15; reasons.push("broker connection stale"); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let level: MarketDangerResult["level"];
  if      (score >= 80) level = "CRITICAL";
  else if (score >= 60) level = "DANGEROUS";
  else if (score >= 35) level = "ELEVATED";
  else                  level = "CALM";

  if (reasons.length === 0) reasons.push("conditions calm");

  return {
    dangerScore: score,
    level,
    shouldOverride: score >= OVERRIDE_THRESHOLD,
    reasons,
  };
}
