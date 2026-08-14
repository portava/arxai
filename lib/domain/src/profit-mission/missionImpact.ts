// ── Profit Mission Phase 5 — Mission Impact Preview (pure projection) ───────
//
// PLANNING / DISPLAY ONLY. Given a mission's math context and a planned setup
// (risk amount + reward-to-risk), this projects what the trade WOULD do to the
// mission if its take-profit is reached (win), if its stop-loss is hit (loss),
// and a probability-weighted expected case. It reports the change in mission
// progress and the change in the required go-forward daily pace.
//
// HONESTY: every number is a labelled ESTIMATE, never a promise. The summary
// copy is checked against the mission banned-vocabulary guard. This composes
// computeMissionMath; it never re-derives mission math.
//
// PURE + DETERMINISTIC + IO-FREE (clock supplied via the math input's `nowMs`).

import { computeMissionMath } from "./missionMath.js";
import type { MissionMathInput } from "./types.js";

export interface MissionImpactInput {
  /** Mission math context (starting/target/current/timeframe/now). */
  math: MissionMathInput;
  /** $ at risk if the stop-loss is hit (the planned loss). */
  riskAmount: number;
  /** Reward-to-risk: take-profit gain = riskAmount * expectedR. */
  expectedR: number;
  /** Win probability 0..1 for the expected case (advisory; default 0.5). */
  winProbability?: number | null;
}

export interface MissionImpactScenario {
  label: "win" | "loss" | "expected";
  /** Account value after this scenario. */
  resultingValue: number;
  /** Change in account value (+win / −loss / weighted). */
  profitDelta: number;
  /** Mission progress % after this scenario. */
  progressPctAfter: number;
  /** Change in progress % vs now (positive = closer to target). */
  progressPctDelta: number;
  /** Remaining $ profit needed after this scenario. */
  remainingProfitAfter: number;
  /** Required go-forward daily pace ($/day) after this scenario. */
  requiredDailyPaceAfter: number;
  /** Change in required pace (negative = pace eased, positive = harder). */
  requiredDailyPaceDelta: number;
}

export interface MissionImpact {
  current: {
    currentValue: number;
    progressPct: number;
    remainingProfit: number;
    requiredDailyPace: number;
  };
  win: MissionImpactScenario;
  loss: MissionImpactScenario;
  expected: MissionImpactScenario;

  riskAmount: number;
  takeProfitGain: number;
  expectedR: number;
  winProbability: number;

  /** Banned-vocabulary-safe, estimate-labelled summary. */
  summary: string;
  /** Always true — these are labelled estimates, not promises. */
  isEstimate: true;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(round2(n)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Project a mission's progress + required pace under win / loss / expected
 * outcomes of a planned setup. Pure; composes computeMissionMath.
 */
export function computeMissionImpact(input: MissionImpactInput): MissionImpact {
  const math = computeMissionMath(input.math);
  const startingAmount = math.startingAmount;
  const targetAmount = math.targetAmount;
  const currentValue = math.currentValue;
  const requiredProfit = math.requiredProfit;
  const remainingDays = math.remainingDays;

  const riskAmount = Math.max(0, Number(input.riskAmount) || 0);
  const expectedR = Math.max(0, Number(input.expectedR) || 0);
  const takeProfitGain = round2(riskAmount * expectedR);
  const winProbability = clamp(
    input.winProbability == null || !Number.isFinite(input.winProbability) ? 0.5 : Number(input.winProbability),
    0,
    1,
  );

  // Go-forward pace = remaining profit spread over remaining days. Once the
  // target is reached the required pace is 0.
  const forwardPace = (remainingProfit: number): number => {
    if (remainingProfit <= 0) return 0;
    if (remainingDays > 0) return round2(remainingProfit / remainingDays);
    return round2(remainingProfit);
  };

  const progressOf = (value: number): number =>
    requiredProfit !== 0 ? round2(((value - startingAmount) / requiredProfit) * 100) : 0;

  const currentRemaining = round2(targetAmount - currentValue);
  const currentProgress = progressOf(currentValue);
  const currentPace = forwardPace(currentRemaining);

  const buildScenario = (label: MissionImpactScenario["label"], profitDelta: number): MissionImpactScenario => {
    const resultingValue = round2(currentValue + profitDelta);
    const remainingProfitAfter = round2(targetAmount - resultingValue);
    const progressPctAfter = progressOf(resultingValue);
    const requiredDailyPaceAfter = forwardPace(remainingProfitAfter);
    return {
      label,
      resultingValue,
      profitDelta: round2(profitDelta),
      progressPctAfter,
      progressPctDelta: round2(progressPctAfter - currentProgress),
      remainingProfitAfter,
      requiredDailyPaceAfter,
      requiredDailyPaceDelta: round2(requiredDailyPaceAfter - currentPace),
    };
  };

  const win = buildScenario("win", takeProfitGain);
  const loss = buildScenario("loss", -riskAmount);
  const expectedDelta = winProbability * takeProfitGain - (1 - winProbability) * riskAmount;
  const expected = buildScenario("expected", expectedDelta);

  const summary =
    `Estimate only. If the take-profit is reached, mission progress changes by ` +
    `${win.progressPctDelta >= 0 ? "+" : ""}${win.progressPctDelta}% and the required daily pace ` +
    `${win.requiredDailyPaceDelta <= 0 ? "eases by " + fmtMoney(Math.abs(win.requiredDailyPaceDelta)) : "rises by " + fmtMoney(win.requiredDailyPaceDelta)}. ` +
    `If the stop-loss is hit, progress changes by ${loss.progressPctDelta}% and the required pace ` +
    `rises by ${fmtMoney(Math.abs(loss.requiredDailyPaceDelta))}. ` +
    `Expected case (at a ${Math.round(winProbability * 100)}% win-rate estimate): ` +
    `${fmtMoney(expected.profitDelta)}. A loss is possible; these figures are projections, not promises.`;

  return {
    current: {
      currentValue: round2(currentValue),
      progressPct: currentProgress,
      remainingProfit: currentRemaining,
      requiredDailyPace: currentPace,
    },
    win,
    loss,
    expected,
    riskAmount: round2(riskAmount),
    takeProfitGain,
    expectedR: round2(expectedR),
    winProbability,
    summary,
    isEstimate: true,
  };
}
