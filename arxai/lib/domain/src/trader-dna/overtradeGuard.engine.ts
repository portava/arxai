import type { Trade } from "../trade/trade.types";
import type { DnaReport, TraderProfile } from "./traderProfile.types";

export interface OvertradeReport extends DnaReport {
  tradesToday: number;
  baseline: number;
  ratio: number;
  recommendBlock: boolean;
}

// Overtrade thresholds (relative to personal baseline)
const CAUTION_RATIO  = 1.5;
const HIGH_RATIO     = 2.0;
const CRITICAL_RATIO = 3.0;

// Hard floor — even traders with very low baselines need *some* allowance
// before "ratio" becomes meaningful. Below this many trades/day we never
// flag overtrading.
const HARD_FLOOR_PER_DAY = 3;

export function evaluateOvertrade(
  profile: TraderProfile,
  trades: Trade[],
  now: Date = new Date(),
): OvertradeReport {
  const today = new Date(now);
  const dayKey = today.toISOString().slice(0, 10);
  const tradesToday = trades.filter(
    (t) => new Date(t.openedAt).toISOString().slice(0, 10) === dayKey,
  ).length;

  const baseline = Math.max(1, profile.baselineTradesPerDay);
  const ratio = tradesToday / baseline;

  if (tradesToday < HARD_FLOOR_PER_DAY || ratio < CAUTION_RATIO) {
    return {
      detected: false, severity: "NONE", confidence: 0,
      evidence: [`${tradesToday} trades today vs baseline ${baseline.toFixed(1)} (ratio ${ratio.toFixed(2)})`],
      recommendation: null,
      tradesToday, baseline, ratio, recommendBlock: false,
    };
  }

  let severity: DnaReport["severity"];
  let recommendation: string;
  let recommendBlock = false;

  if (ratio >= CRITICAL_RATIO) {
    severity = "CRITICAL";
    recommendBlock = true;
    recommendation = "Block all new entries for the rest of the session. Trade volume is 3× baseline.";
  } else if (ratio >= HIGH_RATIO) {
    severity = "HIGH";
    recommendBlock = true;
    recommendation = "Block new entries until next session. Review whether each open position has a thesis.";
  } else {
    severity = "MEDIUM";
    recommendation = "Slow down. Require a written setup note before the next entry.";
  }

  return {
    detected: true,
    severity,
    confidence: Math.min(100, Math.round(50 + (ratio - CAUTION_RATIO) * 40)),
    evidence: [
      `${tradesToday} trades today vs baseline ${baseline.toFixed(1)}`,
      `${ratio.toFixed(2)}× baseline`,
    ],
    recommendation,
    tradesToday, baseline, ratio, recommendBlock,
  };
}
