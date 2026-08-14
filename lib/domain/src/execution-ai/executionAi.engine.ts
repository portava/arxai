import {
  type ApprovedSignal, type ExecutionDecision, type LiveConditions, type ApprovalRegistryPort,
  EXECUTION_THRESHOLDS,
} from "./executionAi.types";
import { evaluateConditions } from "./liveConditionMonitor.engine";

// runExecutionAi — central decision engine for the Execution AI role.
// Composition of three fail-closed gates:
//   1. Approval gate     — strategy MUST be at LIMITED_LIVE or FULL_APPROVAL
//                          to execute. PAPER/MICRO/NOT_APPROVED → REJECT.
//                          (MICRO_ONLY is a development tier — Execution AI
//                          treats it as not yet cleared for real broker;
//                          a separate micro-test runner handles MICRO.)
//   2. Kill-switch gate  — fail-closed if the kill switch is active.
//   3. Conditions gate   — spread, volatility, news, broker online check.
//
// Per-tier size cap: LIMITED_LIVE caps at 0.50 lots, FULL_APPROVAL passes
// the requested size through. Defensively NEVER UPSCALES — only caps.
//
// Risk rules: Execution AI does NOT decide WHETHER to take a trade;
// the upstream chain (judge + governor) already approved it. Execution AI
// only manages WHEN/IF to actually fire given live conditions. The
// risk-governor is composed downstream and retains final veto.
export async function runExecutionAi(
  signal: ApprovedSignal,
  conditions: LiveConditions,
  approvalRegistry: ApprovalRegistryPort,
): Promise<ExecutionDecision> {
  const T = EXECUTION_THRESHOLDS;
  const reasons: string[] = [];

  // Always re-check approval at execution time — tier may have been
  // demoted since signal creation.
  const currentTier = await approvalRegistry.getApprovalTier(signal.strategyId);
  reasons.push(`registry tier for ${signal.strategyId} = ${currentTier} (signal claimed ${signal.approvedTier})`);
  if (currentTier !== "LIMITED_LIVE" && currentTier !== "FULL_APPROVAL") {
    reasons.push(`tier ${currentTier} not cleared for live execution — REJECT`);
    return { verdict: "REJECT_NOT_APPROVED", effectiveSizeLots: 0, reasons };
  }

  if (conditions.killSwitchActive) {
    reasons.push("kill-switch active — fail-closed REJECT");
    return { verdict: "REJECT_KILL_SWITCH", effectiveSizeLots: 0, reasons };
  }

  const condEval = evaluateConditions(conditions);
  reasons.push(...condEval.reasons);
  if (!condEval.conditionsAcceptable) {
    return { verdict: "REJECT_BAD_CONDITIONS", effectiveSizeLots: 0, reasons };
  }

  // Per-tier size cap — defensive Math.min, never upscales
  let effectiveSize = signal.intendedSizeLots;
  if (currentTier === "LIMITED_LIVE") {
    effectiveSize = Math.min(effectiveSize, T.limitedMaxSizeLots);
    reasons.push(`LIMITED_LIVE tier — size capped to ${effectiveSize.toFixed(2)} lots (max ${T.limitedMaxSizeLots})`);
  } else {
    reasons.push(`FULL_APPROVAL tier — size pass-through ${effectiveSize.toFixed(2)} lots`);
  }

  if (effectiveSize <= 0) {
    reasons.push("effective size 0 — HOLD");
    return { verdict: "HOLD", effectiveSizeLots: 0, reasons };
  }
  return { verdict: "EXECUTE", effectiveSizeLots: effectiveSize, reasons };
}
