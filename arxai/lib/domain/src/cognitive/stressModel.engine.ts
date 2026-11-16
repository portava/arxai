import { type StressState, clamp01 } from "./cognitive.types";

// ═══════════════════════════════════════════════════════════════════════════
// Stress Model — instantaneous stress reading from drawdown shock,
// open-position MTM volatility, error rate, recent loss streak.
//
//   stress = w_dd·ddShock + w_pnl·mtmVol + w_err·errRate + w_streak·streak
//   acuteSpike := (stress ≥ 0.80) OR (ddShock ≥ 0.50)
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface StressInput {
  drawdownShock01: number;        // 1 = at hard limit
  mtmVolatility01: number;        // realised P&L vol normalised
  errorRate01: number;
  consecutiveLosses: number;
  lossStreakK?: number;           // default 5 saturates streak
}

export function computeStressState(input: StressInput): StressState {
  const reasons: string[] = [];
  const dd = clamp01(input.drawdownShock01);
  const pnl = clamp01(input.mtmVolatility01);
  const err = clamp01(input.errorRate01);
  const streakSat = clamp01(Math.max(0, input.consecutiveLosses) / (input.lossStreakK ?? 5));
  const stress01 = clamp01(0.40 * dd + 0.25 * pnl + 0.15 * err + 0.20 * streakSat);
  const acuteSpike = stress01 >= 0.80 || dd >= 0.50;
  reasons.push(`dd ${dd.toFixed(2)} · mtmVol ${pnl.toFixed(2)} · err ${err.toFixed(2)} · streak ${streakSat.toFixed(2)} → ${stress01.toFixed(2)}${acuteSpike ? " (ACUTE)" : ""}`);
  return { stress01, acuteSpike, reasons };
}
