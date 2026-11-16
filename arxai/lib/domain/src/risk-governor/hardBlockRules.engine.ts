import {
  HardBlockInputSchema, type HardBlockInput, type HardBlockVerdict,
  type GuardKind,
} from "./riskRules.types";
import { evaluateDrawdownGuard } from "./drawdownGuard.engine";
import { evaluateExposureGuard } from "./exposureGuard.engine";
import { evaluateMaxLossGuard } from "./maxLossGuard.engine";

// evaluateHardBlockRules
//
// Composite — runs the 3 mandatory pre-trade sub-guards and folds them into
// a single hard-block verdict. Order is fixed: drawdown → exposure → maxLoss.
//
// Contract:
//   • If ANY sub-guard returns passed=false, the composite is BLOCKED.
//   • Reasons are accumulated across sub-guards (prefix `[<kind>]`).
//   • dataMissing propagates upward when any sub-guard couldn't read.
//
// This is the Phase-1 single source of truth for "no live trade may execute"
// decisions. It does NOT subsume the master `evaluateRiskGovernor` which also
// runs spread / mt5 / news / revenge — they remain separate by design (defense
// in depth).
export function evaluateHardBlockRules(rawInput: HardBlockInput): HardBlockVerdict {
  const input = HardBlockInputSchema.parse(rawInput);
  const now = (input.now ?? new Date()).toISOString();

  const sub = [
    evaluateDrawdownGuard(input.drawdown),
    evaluateExposureGuard(input.exposure),
    evaluateMaxLossGuard(input.maxLoss),
  ];

  const blockingKinds: GuardKind[] = sub.filter((s) => !s.passed).map((s) => s.kind);
  const reasons: string[] = sub
    .filter((s) => !s.passed)
    .flatMap((s) => s.reasons.map((r) => `[${s.kind}] ${r}`));
  const passed = blockingKinds.length === 0;
  const dataMissing = sub.some((s) => s.dataMissing);

  return {
    kind: "HARD_BLOCK",
    passed,
    reasons: passed ? ["all hard-block rules satisfied"] : reasons,
    observed: {
      blockingCount: blockingKinds.length,
      subGuardCount: sub.length,
    },
    thresholds: { requiredPassed: sub.length },
    dataMissing,
    evaluatedAtIso: now,
    subVerdicts: sub,
    blockingKinds,
  };
}
