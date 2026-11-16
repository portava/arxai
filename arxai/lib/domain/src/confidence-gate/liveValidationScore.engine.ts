import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";

// Live validation — does the strategy's *forward* performance match its
// *backtest* expectation? Big divergence = stop trusting the backtest.

const MIN_FORWARD_SAMPLE = 10;
const ALLOWED_WIN_RATE_DRIFT = 0.15;  // 15 percentage points
const CRITICAL_WIN_RATE_DRIFT = 0.25;

export function scoreLiveValidation(ctx: ConfidenceGateContext): ScoreReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];
  const lv = ctx.liveValidation;

  // Not enough live data yet — neutral score, never block on too-little-data.
  if (lv.forwardTradesCount < MIN_FORWARD_SAMPLE) {
    reasons.push(`Forward sample ${lv.forwardTradesCount} < ${MIN_FORWARD_SAMPLE} — not enough live data, neutral`);
    warnings.push("Live validation neutral until forward sample matures");
    return {
      dimension: "liveValidation",
      score: 70, weight: SCORE_WEIGHTS.liveValidation,
      blockers, warnings, reasons,
      evidence: {
        forwardTradesCount: lv.forwardTradesCount,
        expectedWinRate: lv.expectedWinRate,
      },
    };
  }

  if (lv.forwardWinRate == null || lv.forwardExpectancyR == null) {
    reasons.push("Forward stats incomplete — defaulting score");
    return {
      dimension: "liveValidation",
      score: 60, weight: SCORE_WEIGHTS.liveValidation,
      blockers, warnings, reasons,
      evidence: { lv },
    };
  }

  // Score components
  const wrDrift = lv.expectedWinRate - lv.forwardWinRate;       // positive = underperforming
  const wrDriftAbs = Math.abs(wrDrift);
  let wrScore = 60;
  if (wrDriftAbs <= 0.05) wrScore = 60;
  else if (wrDriftAbs <= ALLOWED_WIN_RATE_DRIFT) wrScore = 40;
  else if (wrDriftAbs <= CRITICAL_WIN_RATE_DRIFT) wrScore = 20;
  else wrScore = 0;

  if (wrDrift > CRITICAL_WIN_RATE_DRIFT) {
    blockers.push({ severity: "AI", dimension: "liveValidation",
      message: `Forward win rate ${(lv.forwardWinRate * 100).toFixed(1)}% vs expected ${(lv.expectedWinRate * 100).toFixed(1)}% — ${(wrDrift * 100).toFixed(1)}pp underperformance` });
  } else if (wrDrift > ALLOWED_WIN_RATE_DRIFT) {
    warnings.push(`Forward win rate underperforming by ${(wrDrift * 100).toFixed(1)}pp`);
  }

  // Expectancy alignment (0..40)
  const expDrift = lv.expectedExpectancyR - lv.forwardExpectancyR;
  let expScore = 40;
  if (expDrift > 1)   expScore = 0;
  else if (expDrift > 0.5) expScore = 15;
  else if (expDrift > 0.2) expScore = 30;
  if (lv.forwardExpectancyR <= 0) {
    blockers.push({ severity: "AI", dimension: "liveValidation",
      message: `Forward expectancy ${lv.forwardExpectancyR.toFixed(2)}R ≤ 0 — strategy losing live` });
  }

  const score = Math.round(wrScore + expScore);

  reasons.push(`Win rate drift ${(wrDrift * 100).toFixed(1)}pp → ${wrScore}/60`);
  reasons.push(`Expectancy drift ${expDrift.toFixed(2)}R → ${expScore}/40`);

  return {
    dimension: "liveValidation",
    score, weight: SCORE_WEIGHTS.liveValidation,
    blockers, warnings, reasons,
    evidence: {
      forwardTradesCount: lv.forwardTradesCount,
      forwardWinRate: lv.forwardWinRate,
      expectedWinRate: lv.expectedWinRate,
      forwardExpectancyR: lv.forwardExpectancyR,
      expectedExpectancyR: lv.expectedExpectancyR,
      lastUpdatedAt: lv.lastUpdatedAt,
    },
  };
}
