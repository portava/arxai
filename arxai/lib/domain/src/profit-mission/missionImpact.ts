// ── Profit Mission Phase 5 — Mission Impact Preview (pure projection) ───────
//
// PLANNING / DISPLAY ONLY. Given a mission's math context and a planned setup
// (risk amount + reward-to-risk), this projects what the trade WOULD do to the
// mission if its take-profit is reached (win), if its stop-loss is hit (loss),
// without inventing a probability-weighted expected case. It reports the change in mission
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
  /** Unavailable: this contract has no measured probability bound to the plan. */
  expected: null;

  riskAmount: number;
  takeProfitGain: number;
  expectedR: number;
  winProbability: null;

  /** Banned-vocabulary-safe, estimate-labelled summary. */
  summary: string;
  /** Always true — these are labelled estimates, not promises. */
  isEstimate: true;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(round2(n)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Project a mission's progress + required pace under conditional win / loss
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
  return {
    current: {
      currentValue: round2(currentValue),
      progressPct: currentProgress,
      remainingProfit: currentRemaining,
      requiredDailyPace: currentPace,
    },
    win,
    loss,
    expected: null,
    riskAmount: round2(riskAmount),
    takeProfitGain,
    expectedR: round2(expectedR),
    winProbability: null,
    summary: impactSummary(win, loss),
    isEstimate: true,
  };
}

function impactSummary(win: MissionImpactScenario, loss: MissionImpactScenario): string {
  return (
    `Estimate only. If the take-profit is reached, mission progress changes by ` +
    `${win.progressPctDelta >= 0 ? "+" : ""}${win.progressPctDelta}% and the required daily pace ` +
    `${win.requiredDailyPaceDelta <= 0 ? "eases by " + fmtMoney(Math.abs(win.requiredDailyPaceDelta)) : "rises by " + fmtMoney(win.requiredDailyPaceDelta)}. ` +
    `If the stop-loss is hit, progress changes by ${loss.progressPctDelta}% and the required pace ` +
    `rises by ${fmtMoney(Math.abs(loss.requiredDailyPaceDelta))}. ` +
    `Expected return unavailable: no measured win probability is bound to this trade plan. ` +
    `A loss is possible; these figures are projections, not promises.`
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function scenario(value: unknown, label: "win" | "loss"): MissionImpactScenario | null {
  const r = record(value);
  if (!r || r.label !== label || !finite(r.resultingValue) || !finite(r.profitDelta) ||
      !finite(r.progressPctAfter) || !finite(r.progressPctDelta) ||
      !finite(r.remainingProfitAfter) || !finite(r.requiredDailyPaceAfter) ||
      !finite(r.requiredDailyPaceDelta) || r.requiredDailyPaceAfter < 0) return null;
  return {
    label, resultingValue: r.resultingValue, profitDelta: r.profitDelta,
    progressPctAfter: r.progressPctAfter, progressPctDelta: r.progressPctDelta,
    remainingProfitAfter: r.remainingProfitAfter,
    requiredDailyPaceAfter: r.requiredDailyPaceAfter,
    requiredDailyPaceDelta: r.requiredDailyPaceDelta,
  };
}

/**
 * Allowlist persisted/cached previews at every public read boundary. Legacy
 * expected values were derived from heuristic scores or a 50% default, without
 * calibration provenance tied to the plan. Never serve those values or their
 * stored summary. Conditional scenarios survive only when internally valid.
 * This does not mutate or purge the persisted record.
 */
export function projectMissionImpact(value: unknown): MissionImpact | null {
  const r = record(value);
  const c = record(r?.current);
  const win = scenario(r?.win, "win");
  const loss = scenario(r?.loss, "loss");
  if (!r || !c || !win || !loss || !finite(c.currentValue) || !finite(c.progressPct) ||
      !finite(c.remainingProfit) || !finite(c.requiredDailyPace) || c.requiredDailyPace < 0 ||
      !finite(r.riskAmount) || r.riskAmount < 0 || !finite(r.takeProfitGain) || r.takeProfitGain < 0 ||
      !finite(r.expectedR) || r.expectedR < 0) return null;
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 0.011;
  if (!close(win.profitDelta, r.takeProfitGain) || !close(loss.profitDelta, -r.riskAmount)) return null;
  for (const s of [win, loss]) {
    if (!close(s.resultingValue, c.currentValue + s.profitDelta) ||
        !close(s.progressPctDelta, s.progressPctAfter - c.progressPct) ||
        !close(s.remainingProfitAfter, c.remainingProfit - s.profitDelta) ||
        !close(s.requiredDailyPaceDelta, s.requiredDailyPaceAfter - c.requiredDailyPace)) return null;
  }

  return {
    current: {
      currentValue: c.currentValue,
      progressPct: c.progressPct,
      remainingProfit: c.remainingProfit,
      requiredDailyPace: c.requiredDailyPace,
    },
    win,
    loss,
    expected: null,
    riskAmount: r.riskAmount,
    takeProfitGain: r.takeProfitGain,
    expectedR: r.expectedR,
    winProbability: null,
    summary: impactSummary(win, loss),
    isEstimate: true,
  };
}
