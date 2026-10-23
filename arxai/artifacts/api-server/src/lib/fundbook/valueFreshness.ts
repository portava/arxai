// ARX Fund Book — investor value freshness classification (Task #133), PURE.
//
// SAFETY / HONESTY (inviolable):
// - 5-state freshness (FRESH / DELAYED / STALE / UNDER_REVIEW / MISSING) for any
//   value an investor sees. It is a VISIBILITY signal only — it never closes a
//   position, never reconciles anything out, and never touches any execution
//   path.
// - The investor message is CLEAN: no broker internals, no admin notes, no raw
//   magnitudes. The admin source string carries the exact reason for operators.
// - UNDER_REVIEW takes precedence over the raw broker freshness whenever a value
//   is being verified (NAV under review, an open discrepancy on it, or a freeze
//   touching it) — the investor sees the calm "being verified" message.
// - No paper/sim/mock/fake or guaranteed-return wording anywhere.

import type { BrokerFreshness } from "./mirrorFreshness.js";

export type ValueFreshness = "FRESH" | "DELAYED" | "STALE" | "UNDER_REVIEW" | "MISSING";

export interface ValueFreshnessResult {
  status: ValueFreshness;
  // Clean, investor-safe message (never shown an internal).
  investorMessage: string;
  // Exact source/reason for admins (never shown to investors).
  adminSource: string;
}

const INVESTOR_MESSAGE: Record<ValueFreshness, string> = {
  FRESH: "Your values are up to date.",
  DELAYED: "Your values are updating.",
  STALE: "We're refreshing your latest values.",
  UNDER_REVIEW: "Your values are temporarily being verified.",
  MISSING: "Your values will appear once your account finishes syncing.",
};

/** Investor-safe message for a freshness state (no internals). */
export function investorMessageFor(status: ValueFreshness): string {
  return INVESTOR_MESSAGE[status];
}

export interface ValueFreshnessInput {
  brokerFreshness: BrokerFreshness;
  brokerAgeMs: number | null;
  // NAV row status (e.g. "OK" | "UNDER_REVIEW").
  navStatus?: string | null;
  // An OPEN/INVESTIGATING discrepancy touches this value.
  hasOpenDiscrepancy?: boolean;
  // A freeze touches this value (investor/pool/withdrawals/etc).
  isFrozen?: boolean;
}

/**
 * Classify an investor value's freshness. Verification states (NAV under
 * review, an open discrepancy, or an active freeze) win and surface as
 * UNDER_REVIEW; otherwise the raw 4-state broker freshness maps through 1:1.
 */
export function classifyValueFreshness(input: ValueFreshnessInput): ValueFreshnessResult {
  const ageSecs = input.brokerAgeMs == null ? null : Math.round(input.brokerAgeMs / 1000);

  if (input.navStatus === "UNDER_REVIEW" || input.hasOpenDiscrepancy || input.isFrozen) {
    const reasons: string[] = [];
    if (input.navStatus === "UNDER_REVIEW") reasons.push("navStatus=UNDER_REVIEW");
    if (input.hasOpenDiscrepancy) reasons.push("open discrepancy");
    if (input.isFrozen) reasons.push("freeze active");
    return {
      status: "UNDER_REVIEW",
      investorMessage: INVESTOR_MESSAGE.UNDER_REVIEW,
      adminSource: `under review: ${reasons.join(", ")}`,
    };
  }

  const status: ValueFreshness = input.brokerFreshness;
  const adminSource =
    status === "MISSING"
      ? "no broker sync received"
      : `broker sync ${ageSecs == null ? "unknown" : `${ageSecs}s`} ago`;
  return { status, investorMessage: INVESTOR_MESSAGE[status], adminSource };
}
