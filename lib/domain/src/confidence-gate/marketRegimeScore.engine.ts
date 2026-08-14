import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";

// Each strategy declares which regimes it is built for. Strategies whose
// "preferred regimes" don't include the current regime are penalised.
// Heuristic mapping — owned here so the gate stays self-contained.
const STRATEGY_PREFERRED_REGIMES: Record<string, ReadonlyArray<string>> = {
  "sniper-entry":          ["TRENDING", "VOLATILE"],
  "london-breakout":       ["VOLATILE", "TRENDING"],
  "trend-continuation":    ["TRENDING"],
  "reversal-hunter":       ["RANGING", "QUIET"],
  "news-avoidance":        ["TRENDING", "RANGING", "QUIET"],
};

export function scoreMarketRegime(ctx: ConfidenceGateContext): ScoreReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];

  const snap = ctx.marketSnapshot;
  const strategy = ctx.strategyStats.strategyName;
  const regime = snap.regime?.regime ?? "UNKNOWN";
  const liquidity = (snap.liquidity as { score?: number })?.score ?? 50;
  const volatility = (snap.volatility as { score?: number; level?: string })?.score ?? 50;
  const sessionLabel = ctx.marketSnapshot.updatedAt;

  // Hard blockers — never trade with no market data
  if (!snap || !snap.regime) {
    blockers.push({ severity: "DATA", dimension: "marketRegime",
      message: "No market regime data available" });
  }

  // 1. Regime alignment (0..50)
  const preferred = STRATEGY_PREFERRED_REGIMES[strategy] ?? [];
  const aligned = preferred.includes(regime as string);
  const alignmentScore = aligned ? 50 : preferred.length === 0 ? 30 : 15;
  if (!aligned && preferred.length > 0) {
    warnings.push(`Strategy ${strategy} prefers ${preferred.join("/")}; current regime ${regime}`);
  }
  // 2. Liquidity (0..25) — 0..100 input scaled
  const liquidityScore = Math.round((Math.max(0, Math.min(100, liquidity)) / 100) * 25);
  if (liquidity < 30) {
    blockers.push({ severity: "DATA", dimension: "marketRegime",
      message: `Liquidity score ${liquidity.toFixed(0)} < 30 — thin market` });
  }
  // 3. Volatility band (0..25) — penalise extremes
  let volScore = 25;
  if (volatility > 90)      { volScore = 5;  warnings.push(`Volatility ${volatility.toFixed(0)} extremely high`); }
  else if (volatility > 75) { volScore = 15; warnings.push(`Volatility ${volatility.toFixed(0)} elevated`); }
  else if (volatility < 15) { volScore = 10; warnings.push(`Volatility ${volatility.toFixed(0)} too low`); }

  const score = Math.round(alignmentScore + liquidityScore + volScore);

  reasons.push(`Strategy ${strategy} vs regime ${regime} → ${alignmentScore}/50`);
  reasons.push(`Liquidity ${liquidity.toFixed(0)} → ${liquidityScore}/25`);
  reasons.push(`Volatility ${volatility.toFixed(0)} → ${volScore}/25`);

  return {
    dimension: "marketRegime",
    score, weight: SCORE_WEIGHTS.marketRegime,
    blockers, warnings, reasons,
    evidence: { regime, liquidity, volatility, sessionLabel, preferredRegimes: preferred, aligned },
  };
}
