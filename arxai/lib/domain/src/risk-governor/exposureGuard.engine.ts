import {
  ExposureGuardInputSchema, type ExposureGuardInput, type GuardVerdict,
} from "./riskRules.types";

// evaluateExposureGuard
//
// Pure single-concern guard. Three sub-checks, evaluated independently:
//   • Open-trade count ≤ cap.
//   • Total exposure % ≤ cap (fail-closed when null).
//   • Per-symbol concentration ≤ maxPerSymbol.
export function evaluateExposureGuard(rawInput: ExposureGuardInput): GuardVerdict {
  const input = ExposureGuardInputSchema.parse(rawInput);
  const now = (input.now ?? new Date()).toISOString();
  const reasons: string[] = [];
  let dataMissing = false;
  let passed = true;

  if (input.openTradeCount > input.maxOpenTrades) {
    passed = false;
    reasons.push(`${input.openTradeCount} open trades > cap ${input.maxOpenTrades}`);
  }

  if (input.totalExposurePct === null) {
    dataMissing = true;
    passed = false;
    reasons.push("total exposure % unavailable — fail-closed");
  } else if (input.totalExposurePct > input.maxExposurePct) {
    passed = false;
    reasons.push(
      `exposure ${input.totalExposurePct.toFixed(1)}% > cap ${input.maxExposurePct.toFixed(1)}%`,
    );
  }

  const overConcentrated = input.perSymbolCount.filter((p) => p.count > input.maxPerSymbol);
  if (overConcentrated.length > 0) {
    passed = false;
    for (const o of overConcentrated) {
      reasons.push(`symbol ${o.symbol}: ${o.count} positions > per-symbol cap ${input.maxPerSymbol}`);
    }
  }

  if (passed) {
    reasons.push(
      `${input.openTradeCount}/${input.maxOpenTrades} trades; ` +
      `exposure ${input.totalExposurePct?.toFixed(1) ?? "?"}%/${input.maxExposurePct.toFixed(1)}%; ` +
      `${input.perSymbolCount.length} symbols, max per symbol ${input.maxPerSymbol}`,
    );
  }

  return {
    kind: "EXPOSURE",
    passed,
    reasons,
    observed: {
      openTradeCount: input.openTradeCount,
      totalExposurePct: input.totalExposurePct,
      symbolsTracked: input.perSymbolCount.length,
      overConcentratedCount: overConcentrated.length,
    },
    thresholds: {
      maxOpenTrades: input.maxOpenTrades,
      maxExposurePct: input.maxExposurePct,
      maxPerSymbol: input.maxPerSymbol,
    },
    dataMissing,
    evaluatedAtIso: now,
  };
}
