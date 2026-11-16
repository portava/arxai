// Profit Mission — pure mission math engine.
//
// Computes required profit, return %, daily/session/hourly pace, remaining
// profit/time, and realised-vs-required pace. PURE and DETERMINISTIC: the only
// time source is the caller-supplied `nowMs`.

import type { MissionMath, MissionMathInput } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const TRADING_HOURS_PER_DAY = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Count weekdays (Mon–Fri) in [startMs, endMs]. Deterministic, UTC-based. */
function countTradingDays(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  let count = 0;
  // Iterate calendar days at UTC midnight to stay deterministic.
  const startDay = Math.floor(startMs / MS_PER_DAY);
  const endDay = Math.floor(endMs / MS_PER_DAY);
  for (let d = startDay; d <= endDay; d++) {
    const dow = new Date(d * MS_PER_DAY).getUTCDay(); // 0=Sun … 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

export function computeMissionMath(input: MissionMathInput): MissionMath {
  const startingAmount = Number(input.startingAmount);
  const targetAmount = Number(input.targetAmount);
  const currentValue =
    input.currentValue == null ? startingAmount : Number(input.currentValue);
  const startMs = Number(input.timeframeStartMs);
  const endMs = Number(input.timeframeEndMs);
  const nowMs = Number(input.nowMs);

  const invalidReasons: string[] = [];
  if (!Number.isFinite(startingAmount) || startingAmount <= 0) {
    invalidReasons.push("STARTING_AMOUNT_INVALID");
  }
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    invalidReasons.push("TARGET_AMOUNT_INVALID");
  }
  if (Number.isFinite(startingAmount) && Number.isFinite(targetAmount) && targetAmount <= startingAmount) {
    invalidReasons.push("TARGET_NOT_ABOVE_STARTING");
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    invalidReasons.push("TIMEFRAME_INVALID");
  }

  const requiredProfit = targetAmount - startingAmount;
  const requiredReturnPct =
    startingAmount > 0 ? (requiredProfit / startingAmount) * 100 : 0;
  const remainingProfit = targetAmount - currentValue;

  const totalMs = Math.max(0, endMs - startMs);
  const totalDays = totalMs / MS_PER_DAY;
  const tradingDays = countTradingDays(startMs, endMs);

  const elapsedMs = clamp(nowMs - startMs, 0, totalMs);
  const elapsedDays = elapsedMs / MS_PER_DAY;
  const remainingMs = clamp(endMs - nowMs, 0, totalMs);
  const remainingDays = remainingMs / MS_PER_DAY;

  // Linear pace targets (guard divide-by-zero with safe denominators).
  const safeDays = totalDays > 0 ? totalDays : 1;
  const safeTradingDays = tradingDays > 0 ? tradingDays : 1;
  const requiredDailyProfit = requiredProfit / safeDays;
  const requiredSessionProfit = requiredProfit / safeTradingDays;
  const requiredHourlyProfit = requiredProfit / (safeTradingDays * TRADING_HOURS_PER_DAY);

  // Compound (geometric) daily return needed to grow starting → target.
  let requiredDailyReturnPct = 0;
  if (startingAmount > 0 && targetAmount > startingAmount && totalDays > 0) {
    const growth = targetAmount / startingAmount;
    requiredDailyReturnPct = (Math.pow(growth, 1 / totalDays) - 1) * 100;
  }

  const progressPct =
    requiredProfit !== 0 ? ((currentValue - startingAmount) / requiredProfit) * 100 : 0;
  const progressPctClamped = clamp(progressPct, 0, 100);
  const timeElapsedPct = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 0;

  const currentDailyProfit = elapsedDays > 0 ? (currentValue - startingAmount) / elapsedDays : 0;
  const paceRatio = requiredDailyProfit !== 0 ? currentDailyProfit / requiredDailyProfit : 0;
  const onTrack = currentDailyProfit >= requiredDailyProfit && requiredDailyProfit > 0;

  // Short-timeframe pace fields (minutes-first).
  const timeframeMinutes = Math.max(0, (endMs - startMs)) / MS_PER_MINUTE;
  const safeHours = timeframeMinutes > 0 ? timeframeMinutes / 60 : 1;
  const requiredReturnPerHourPct = timeframeMinutes > 0 ? requiredReturnPct / safeHours : 0;
  const requiredDailyEquivalentReturnPct = requiredReturnPerHourPct * 24;

  return {
    startingAmount,
    targetAmount,
    currentValue,
    requiredProfit,
    requiredReturnPct,
    remainingProfit,
    totalDays,
    tradingDays,
    elapsedDays,
    remainingDays,
    requiredDailyProfit,
    requiredSessionProfit,
    requiredHourlyProfit,
    requiredDailyReturnPct,
    progressPct,
    progressPctClamped,
    timeElapsedPct,
    currentDailyProfit,
    paceRatio,
    onTrack,
    timeframeMinutes,
    requiredReturnPerHourPct,
    requiredDailyEquivalentReturnPct,
    invalid: invalidReasons.length > 0,
    invalidReasons,
  };
}
