import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Execution AI — manages live conditions and approved-execution-only.
// HARD RULE: Execution AI may ONLY act on strategies that have reached
// the approved tier (LIMITED_LIVE or FULL_APPROVAL) in the strategy
// pipeline. Anything else is rejected at the door — it's the fail-closed
// gate between research/development and the broker.
// ═══════════════════════════════════════════════════════════════════════════

export const ApprovalTierSchema = z.enum([
  "NOT_APPROVED",
  "PAPER_ONLY",
  "MICRO_ONLY",
  "LIMITED_LIVE",
  "FULL_APPROVAL",
]);
export type ApprovalTier = z.infer<typeof ApprovalTierSchema>;

export const ExecutionVerdictSchema = z.enum([
  "EXECUTE",
  "HOLD",
  "REJECT_NOT_APPROVED",
  "REJECT_KILL_SWITCH",
  "REJECT_BAD_CONDITIONS",
]);
export type ExecutionVerdict = z.infer<typeof ExecutionVerdictSchema>;

export interface ApprovedSignal {
  signalId: string;
  strategyId: string;
  direction: "BUY" | "SELL";
  intendedPrice: number;
  intendedSizeLots: number;
  stopPrice: number;
  takeProfitPrice: number;
  approvedTier: ApprovalTier;
  approvedAtIso: string;
}

export interface LiveConditions {
  spreadPips: number;
  volatilityRatio: number;              // current atr / avg atr
  isNewsBlackout: boolean;
  killSwitchActive: boolean;
  brokerOnline: boolean;
  observedAt: string;
}

export interface ExecutionDecision {
  verdict: ExecutionVerdict;
  effectiveSizeLots: number;            // 0 if rejected
  reasons: string[];
}

export interface ApprovalRegistryPort {
  getApprovalTier(strategyId: string): Promise<ApprovalTier>;
  setApprovalTier(strategyId: string, tier: ApprovalTier, atIso: string): Promise<void>;
}

export const EXECUTION_THRESHOLDS = {
  maxSpreadPipsToExecute: 5,
  maxVolatilityRatioToExecute: 3.0,
  microMaxSizeLots: 0.10,
  limitedMaxSizeLots: 0.50,
} as const;
