import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";
import { z } from "zod/v4";

// Min sample size below which we don't trust the backtest at all.
const MIN_SAMPLE = 30;
const STRONG_SAMPLE = 200;
const STALE_BACKTEST_DAYS = 60;
const BACKTEST_TIME = z.iso.datetime({ offset: true });

export function scoreStrategyEdge(ctx: ConfidenceGateContext): ScoreReport {
  const s = ctx.strategyStats;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];

  // Invalid evidence must not become a plausible score through JS coercion or
  // comparison fall-through. These are validity checks, not a calibrated policy.
  const invalidFields: string[] = [];
  if (!Number.isFinite(s.backtestWinRate) || s.backtestWinRate < 0 || s.backtestWinRate > 1) invalidFields.push("backtestWinRate");
  if (!Number.isFinite(s.backtestProfitFactor) || s.backtestProfitFactor < 0) invalidFields.push("backtestProfitFactor");
  if (!Number.isSafeInteger(s.backtestSampleSize) || s.backtestSampleSize < 0) invalidFields.push("backtestSampleSize");
  if (!Number.isFinite(s.backtestExpectancyR)) invalidFields.push("backtestExpectancyR");
  const nowMs = ctx.now === undefined ? Date.now() : ctx.now.getTime();
  const backtestMs = BACKTEST_TIME.safeParse(s.lastBacktestAt).success ? Date.parse(s.lastBacktestAt) : NaN;
  if (!Number.isFinite(nowMs)) invalidFields.push("evaluationTime");
  if (!Number.isFinite(backtestMs) || backtestMs > nowMs) invalidFields.push("lastBacktestAt");
  if (invalidFields.length > 0) {
    return {
      dimension: "strategyEdge", score: 0, weight: SCORE_WEIGHTS.strategyEdge,
      blockers: [{ severity: "DATA", dimension: "strategyEdge",
        message: `Strategy score withheld: invalid or future-dated evidence (${invalidFields.join(", ")})` }],
      warnings: [], reasons: ["A strategy score requires valid statistics and a backtest time no later than the evaluation time."],
      evidence: { invalidFields },
    };
  }

  // Hard blockers — strategy must have a baseline edge to trade
  if (s.backtestSampleSize < MIN_SAMPLE) {
    blockers.push({ severity: "DATA", dimension: "strategyEdge",
      message: `Backtest sample ${s.backtestSampleSize} < ${MIN_SAMPLE} — insufficient evidence` });
  }
  if (s.backtestProfitFactor < 1.0) {
    blockers.push({ severity: "AI", dimension: "strategyEdge",
      message: `Backtest profit factor ${s.backtestProfitFactor.toFixed(2)} < 1.0 — strategy is net-losing` });
  }
  if (s.backtestExpectancyR <= 0) {
    blockers.push({ severity: "AI", dimension: "strategyEdge",
      message: `Backtest expectancy ${s.backtestExpectancyR.toFixed(2)}R ≤ 0` });
  }

  // Score components
  // 1. Win rate (0..40)
  const wrScore = Math.min(40, Math.max(0, (s.backtestWinRate - 0.45) * 200));
  // 2. Profit factor (0..30) — PF 1.0 → 0, PF 2.5+ → 30
  const pfScore = Math.min(30, Math.max(0, (s.backtestProfitFactor - 1.0) * 20));
  // 3. Sample size contribution (0..20) — linear toward STRONG_SAMPLE
  const sizeRatio = Math.min(1, s.backtestSampleSize / STRONG_SAMPLE);
  const sampleScore = Math.round(sizeRatio * 20);
  // 4. Recency penalty (0..10) — fresh backtest = 10; stale = 0
  const ageDays = (nowMs - backtestMs) / 86_400_000;
  const recencyScore = Math.max(0, Math.round(10 - (ageDays / STALE_BACKTEST_DAYS) * 10));
  if (ageDays > STALE_BACKTEST_DAYS) {
    warnings.push(`Backtest is ${ageDays.toFixed(0)} days old (>${STALE_BACKTEST_DAYS}) — re-validate`);
  }

  const score = Math.round(wrScore + pfScore + sampleScore + recencyScore);

  reasons.push(`Win rate ${(s.backtestWinRate * 100).toFixed(1)}% → ${wrScore.toFixed(0)}/40`);
  reasons.push(`Profit factor ${s.backtestProfitFactor.toFixed(2)} → ${pfScore.toFixed(0)}/30`);
  reasons.push(`Sample size ${s.backtestSampleSize} → ${sampleScore}/20`);
  reasons.push(`Backtest age ${ageDays.toFixed(0)}d → ${recencyScore}/10`);

  return {
    dimension: "strategyEdge",
    score, weight: SCORE_WEIGHTS.strategyEdge,
    blockers, warnings, reasons,
    evidence: {
      backtestWinRate: s.backtestWinRate,
      backtestProfitFactor: s.backtestProfitFactor,
      backtestSampleSize: s.backtestSampleSize,
      backtestExpectancyR: s.backtestExpectancyR,
      backtestAgeDays: ageDays,
    },
  };
}
