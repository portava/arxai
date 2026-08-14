import {
  MaxLossGuardInputSchema, type MaxLossGuardInput, type GuardVerdict,
} from "./riskRules.types";

// evaluateMaxLossGuard
//
// Pure single-concern guard. Three independent failure conditions:
//   • Daily realized loss ≥ cap (fail-closed when null).
//   • Per-trade loss ≥ cap (advisory; null = not measured, treated as 0).
//   • Consecutive losses ≥ cap.
export function evaluateMaxLossGuard(rawInput: MaxLossGuardInput): GuardVerdict {
  const input = MaxLossGuardInputSchema.parse(rawInput);
  const now = (input.now ?? new Date()).toISOString();
  const reasons: string[] = [];
  let dataMissing = false;
  let passed = true;

  if (input.realizedDailyLossPct === null) {
    dataMissing = true;
    passed = false;
    reasons.push("daily P&L unavailable — fail-closed");
  } else if (input.realizedDailyLossPct >= input.maxDailyLossPct) {
    passed = false;
    reasons.push(
      `realized daily loss ${input.realizedDailyLossPct.toFixed(2)}% ≥ cap ${input.maxDailyLossPct.toFixed(2)}%`,
    );
  }

  if (input.perTradeLossPct !== null && input.perTradeLossPct >= input.maxPerTradeLossPct) {
    passed = false;
    reasons.push(
      `per-trade loss ${input.perTradeLossPct.toFixed(2)}% ≥ cap ${input.maxPerTradeLossPct.toFixed(2)}%`,
    );
  }

  if (input.consecutiveLossCount >= input.maxConsecutiveLosses) {
    passed = false;
    reasons.push(
      `${input.consecutiveLossCount} consecutive losses ≥ cap ${input.maxConsecutiveLosses}`,
    );
  }

  if (passed) {
    reasons.push(
      `daily ${input.realizedDailyLossPct?.toFixed(2) ?? "?"}%/${input.maxDailyLossPct.toFixed(2)}%; ` +
      `per-trade ${input.perTradeLossPct?.toFixed(2) ?? "n/a"}%/${input.maxPerTradeLossPct.toFixed(2)}%; ` +
      `${input.consecutiveLossCount}/${input.maxConsecutiveLosses} consecutive losses`,
    );
  }

  return {
    kind: "MAX_LOSS",
    passed,
    reasons,
    observed: {
      realizedDailyLossPct: input.realizedDailyLossPct,
      perTradeLossPct: input.perTradeLossPct,
      consecutiveLossCount: input.consecutiveLossCount,
    },
    thresholds: {
      maxDailyLossPct: input.maxDailyLossPct,
      maxPerTradeLossPct: input.maxPerTradeLossPct,
      maxConsecutiveLosses: input.maxConsecutiveLosses,
    },
    dataMissing,
    evaluatedAtIso: now,
  };
}
