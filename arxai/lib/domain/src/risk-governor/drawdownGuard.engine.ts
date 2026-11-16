import {
  DrawdownGuardInputSchema, type DrawdownGuardInput, type GuardVerdict,
} from "./riskRules.types";

// evaluateDrawdownGuard
//
// Pure single-concern guard. Fails CLOSED on missing drawdown reading.
// Two derivations honored:
//   1. Direct: `currentDrawdownPct` ≥ `maxDrawdownPct` → fail.
//   2. Implied: when `rollingPeakEquity` + `currentEquity` are present and
//      the implied DD exceeds the cap, also fail (catches stale fields).
export function evaluateDrawdownGuard(rawInput: DrawdownGuardInput): GuardVerdict {
  const input = DrawdownGuardInputSchema.parse(rawInput);
  const now = (input.now ?? new Date()).toISOString();
  const reasons: string[] = [];
  let dataMissing = false;
  let passed = true;

  if (input.currentDrawdownPct === null) {
    dataMissing = true;
    passed = false;
    reasons.push("drawdown reading unavailable — fail-closed");
  } else if (input.currentDrawdownPct >= input.maxDrawdownPct) {
    passed = false;
    reasons.push(
      `drawdown ${input.currentDrawdownPct.toFixed(2)}% ≥ cap ${input.maxDrawdownPct.toFixed(2)}%`,
    );
  }

  let impliedDdPct: number | null = null;
  if (input.rollingPeakEquity !== null && input.currentEquity !== null) {
    impliedDdPct = ((input.rollingPeakEquity - input.currentEquity) / input.rollingPeakEquity) * 100;
    if (impliedDdPct < 0) impliedDdPct = 0;
    if (impliedDdPct >= input.maxDrawdownPct) {
      passed = false;
      reasons.push(
        `implied drawdown ${impliedDdPct.toFixed(2)}% (peak ${input.rollingPeakEquity.toFixed(2)} → ` +
        `current ${input.currentEquity.toFixed(2)}) ≥ cap ${input.maxDrawdownPct.toFixed(2)}%`,
      );
    }
  }

  if (passed) {
    reasons.push(
      `drawdown ${input.currentDrawdownPct?.toFixed(2) ?? "?"}% / ` +
      `${input.maxDrawdownPct.toFixed(2)}% cap — within limit`,
    );
  }

  return {
    kind: "DRAWDOWN",
    passed,
    reasons,
    observed: {
      currentDrawdownPct: input.currentDrawdownPct,
      impliedDrawdownPct: impliedDdPct,
      rollingPeakEquity: input.rollingPeakEquity,
      currentEquity: input.currentEquity,
    },
    thresholds: { maxDrawdownPct: input.maxDrawdownPct },
    dataMissing,
    evaluatedAtIso: now,
  };
}
