// Operator-Funded 10-User Live Pilot — config constants.
//
// SAFETY (inviolable):
// - The pilot is a CAPACITY-CAPPED, OPERATOR-FUNDED, CLOSED cohort. Capital
//   is operator-owned. Users hold an assigned allocation only — never a
//   deposit, withdrawal, custody, investor-fund, or pooled-fund balance.
// - `ARX_OPERATOR_FUNDED_LIVE_PILOT_10` is an ADDITIONAL master switch on
//   top of `ARX_LIVE_BROKER_EXECUTION_ENABLED`. Both must be true plus
//   every Phase B gate plus per-user master-live access. The pilot switch
//   never widens access — it only narrows.
// - Cohort cap is hard-coded at 10. The DB query in
//   `operatorFundedPilotGate` refuses approval #11.
// - Disclosure version pins the exact text hash the user accepted. New
//   text → new version → users re-accept.

export const OPERATOR_FUNDED_PILOT_COHORT = "ARX_PRIVATE_BETA_10" as const;
export const OPERATOR_FUNDED_PILOT_MAX_USERS = 10 as const;

export const OPERATOR_FUNDED_DISCLOSURE_VERSION = "OPERATOR_FUNDED_LIVE_PILOT_V1" as const;

export const OPERATOR_FUNDED_DISCLOSURE_TEXT = [
  "I acknowledge that I am participating in the ARX AI Operator-Funded Live Pilot.",
  "All capital used to place live orders is operator-owned. I am not depositing money.",
  "My assigned trading allocation is a controlled testing limit, not a deposit and not withdrawable.",
  "I receive no ownership of, or claim over, the operator's master account.",
  "I am not entitled to any profit-share, payout, or withdrawal from this pilot.",
  "Operator may pause, revoke, or revoke my live access instantly and without notice.",
  "Ruby analysis is informational only. Live orders always require my explicit confirmation.",
  "Trading involves risk. Past performance is not guaranteed. Results are not guaranteed.",
  "If the system safety state is uncertain my actions may be placed in review.",
].join("\n");

/**
 * Server master switch — must be `true` for ANY live command to be created
 * under the operator-funded pilot. Defaults FALSE. Read once per call so
 * an operator can flip the env var without redeploy.
 */
export function operatorFundedPilotEnabled(): boolean {
  return process.env["ARX_OPERATOR_FUNDED_LIVE_PILOT_10"] === "true";
}

/**
 * Postgres advisory-lock key used to serialize ALL pilot-cohort approval
 * transactions across the cluster. The value is a stable arbitrary 32-bit
 * constant — never reuse this key elsewhere.
 */
export const OPERATOR_FUNDED_PILOT_APPROVE_LOCK_KEY = 4210_1019 as const;

export const PILOT_BLOCK_REASONS = {
  PILOT_DISABLED: "OPERATOR_FUNDED_PILOT_DISABLED",
  NOT_BETA: "OPERATOR_FUNDED_PILOT_USER_NOT_IN_BETA_COHORT",
  BETA_NOT_ACCEPTED: "OPERATOR_FUNDED_PILOT_BETA_INVITE_NOT_ACCEPTED",
  COHORT_FULL: "OPERATOR_FUNDED_PILOT_COHORT_CAP_REACHED",
  COHORT_CAP_EXCEEDED: "OPERATOR_FUNDED_PILOT_COHORT_CAP_EXCEEDED",
  COMPLIANCE_NOT_APPROVED: "OPERATOR_FUNDED_PILOT_COMPLIANCE_REVIEW_NOT_APPROVED",
  NO_ALLOCATION: "OPERATOR_FUNDED_PILOT_NO_ASSIGNED_ALLOCATION",
  DISCLOSURE_MISSING: "OPERATOR_FUNDED_PILOT_DISCLOSURE_NOT_ACCEPTED",
} as const;
export type PilotBlockReason =
  (typeof PILOT_BLOCK_REASONS)[keyof typeof PILOT_BLOCK_REASONS];
