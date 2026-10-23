import { type LiveConditions, EXECUTION_THRESHOLDS } from "./executionAi.types";

export interface ConditionEvaluation {
  conditionsAcceptable: boolean;
  blockers: string[];
  reasons: string[];
}

// evaluateConditions — pure check of whether the current live conditions
// are acceptable for any execution. Killers are reported as blockers[];
// any blocker means conditionsAcceptable=false.
export function evaluateConditions(c: LiveConditions): ConditionEvaluation {
  const T = EXECUTION_THRESHOLDS;
  const blockers: string[] = [];
  const reasons: string[] = [];

  if (c.killSwitchActive)        blockers.push("kill-switch active");
  if (!c.brokerOnline)           blockers.push("broker offline");
  if (c.isNewsBlackout)          blockers.push("news blackout window");
  if (c.spreadPips > T.maxSpreadPipsToExecute) blockers.push(`spread ${c.spreadPips.toFixed(1)}p > ${T.maxSpreadPipsToExecute}p`);
  if (c.volatilityRatio > T.maxVolatilityRatioToExecute) blockers.push(`vol ratio ${c.volatilityRatio.toFixed(2)} > ${T.maxVolatilityRatioToExecute}`);

  reasons.push(blockers.length === 0
    ? `conditions acceptable (spread ${c.spreadPips.toFixed(1)}p, vol ${c.volatilityRatio.toFixed(2)})`
    : `${blockers.length} blocker(s)`);
  return { conditionsAcceptable: blockers.length === 0, blockers, reasons: [...reasons, ...blockers] };
}
