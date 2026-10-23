// drawdownResilience — score how well the system recovers from drawdowns.
// Reads three signals: current drawdown depth, historical max, and mean
// recovery time in days. Returns 0..1 (1 = excellent).

export interface DrawdownInputs {
  currentDrawdownPct: number;
  maxHistoricalDrawdownPct: number;
  meanRecoveryDays: number;
  consecutiveLosingMonthsCount: number;
}

export interface DrawdownResilienceResult {
  score01: number;
  reasons: string[];
}

export const DRAWDOWN_RESILIENCE_THRESHOLDS = {
  excellentMaxDDPct: 5,                 // ≤ 5% historical = excellent
  poorMaxDDPct: 20,                     // ≥ 20% = poor
  excellentRecoveryDays: 7,
  poorRecoveryDays: 60,
  losingMonthsHardCap: 3,               // ≥ 3 consecutive losing months = floor at 0.2
} as const;

export function scoreDrawdownResilience(i: DrawdownInputs): DrawdownResilienceResult {
  const T = DRAWDOWN_RESILIENCE_THRESHOLDS;
  const reasons: string[] = [];

  // Sub-score 1: max historical drawdown (lower is better)
  const ddSub = clamp01(1 - (i.maxHistoricalDrawdownPct - T.excellentMaxDDPct) / (T.poorMaxDDPct - T.excellentMaxDDPct));
  reasons.push(`maxHistoricalDD ${i.maxHistoricalDrawdownPct.toFixed(1)}% → sub-score ${ddSub.toFixed(2)}`);

  // Sub-score 2: recovery time (faster is better)
  const recSub = clamp01(1 - (i.meanRecoveryDays - T.excellentRecoveryDays) / (T.poorRecoveryDays - T.excellentRecoveryDays));
  reasons.push(`meanRecoveryDays ${i.meanRecoveryDays.toFixed(1)} → sub-score ${recSub.toFixed(2)}`);

  // Sub-score 3: current drawdown penalty (deeper now = worse)
  const curSub = clamp01(1 - i.currentDrawdownPct / T.poorMaxDDPct);
  reasons.push(`currentDD ${i.currentDrawdownPct.toFixed(1)}% → sub-score ${curSub.toFixed(2)}`);

  // Composite: equal weight, then hard cap if losing-month streak severe
  let score = (ddSub + recSub + curSub) / 3;
  if (i.consecutiveLosingMonthsCount >= T.losingMonthsHardCap) {
    score = Math.min(score, 0.2);
    reasons.push(`${i.consecutiveLosingMonthsCount} consecutive losing months ≥ ${T.losingMonthsHardCap} — hard cap 0.20`);
  }
  return { score01: score, reasons };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
