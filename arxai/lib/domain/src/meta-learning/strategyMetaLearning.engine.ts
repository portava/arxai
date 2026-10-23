import { z } from "zod/v4";

export const StrategyMetaActionSchema = z.enum(["PROMOTE", "RETIRE", "RETUNE_PARAMS", "KEEP"]);
export type StrategyMetaAction = z.infer<typeof StrategyMetaActionSchema>;

export interface StrategyPerformanceWindow {
  startIso: string;
  sampleCount: number;
  expectancyR: number;
  winRate01: number;
  maxDrawdownPct: number;
}

export interface StrategyPerformanceTimeSeries {
  strategyId: string;
  windows: StrategyPerformanceWindow[];
}

export interface StrategyMetaRecommendation {
  strategyId: string;
  action: StrategyMetaAction;
  confidence01: number;
  reasons: string[];
}

export const STRATEGY_META_THRESHOLDS = {
  minWindowsForTrend: 3,
  minSamplesPerWindow: 20,
  retireExpectancyR: 0.0,               // late expectancy ≤ 0 → retire
  retireDrawdownPct: 15,                // catastrophic drawdown → retire
  promoteExpectancyR: 0.30,
  retuneWinRateInstability: 0.15,       // |late winRate − early winRate| ≥ this → RETUNE
} as const;

export function analyzeStrategyMeta(ts: StrategyPerformanceTimeSeries): StrategyMetaRecommendation {
  const T = STRATEGY_META_THRESHOLDS;
  const reasons: string[] = [];
  const valid = ts.windows.filter((w) => w.sampleCount >= T.minSamplesPerWindow);

  if (valid.length < T.minWindowsForTrend) {
    reasons.push(`only ${valid.length} valid windows < ${T.minWindowsForTrend} required`);
    return { strategyId: ts.strategyId, action: "KEEP", confidence01: 0.2, reasons };
  }

  const halfIdx = Math.floor(valid.length / 2);
  const earlyEx = mean(valid.slice(0, halfIdx).map((w) => w.expectancyR));
  const lateEx  = mean(valid.slice(halfIdx).map((w) => w.expectancyR));
  const earlyWR = mean(valid.slice(0, halfIdx).map((w) => w.winRate01));
  const lateWR  = mean(valid.slice(halfIdx).map((w) => w.winRate01));
  const maxDD   = Math.max(...valid.map((w) => w.maxDrawdownPct));

  reasons.push(`expectancy ${earlyEx.toFixed(2)}R → ${lateEx.toFixed(2)}R; winRate ${(earlyWR * 100).toFixed(0)}% → ${(lateWR * 100).toFixed(0)}%; maxDD ${maxDD.toFixed(1)}%`);

  if (lateEx <= T.retireExpectancyR && earlyEx <= T.retireExpectancyR) {
    return { strategyId: ts.strategyId, action: "RETIRE", confidence01: 0.85,
      reasons: [...reasons, `late expectancy ${lateEx.toFixed(2)}R ≤ 0 with no earlier edge — RETIRE`] };
  }
  if (maxDD >= T.retireDrawdownPct) {
    return { strategyId: ts.strategyId, action: "RETIRE", confidence01: 0.80,
      reasons: [...reasons, `catastrophic drawdown ${maxDD.toFixed(1)}% ≥ ${T.retireDrawdownPct}% — RETIRE`] };
  }
  if (Math.abs(lateWR - earlyWR) >= T.retuneWinRateInstability) {
    return { strategyId: ts.strategyId, action: "RETUNE_PARAMS", confidence01: 0.65,
      reasons: [...reasons, `winRate shift |${(lateWR - earlyWR).toFixed(2)}| ≥ ${T.retuneWinRateInstability} — RETUNE_PARAMS`] };
  }
  if (lateEx >= T.promoteExpectancyR) {
    return { strategyId: ts.strategyId, action: "PROMOTE", confidence01: Math.min(1, lateEx / T.promoteExpectancyR * 0.5),
      reasons: [...reasons, `late expectancy ${lateEx.toFixed(2)}R ≥ ${T.promoteExpectancyR}R — PROMOTE`] };
  }
  return { strategyId: ts.strategyId, action: "KEEP", confidence01: 0.5, reasons: [...reasons, "stable — KEEP"] };
}

function mean(arr: number[]): number { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
