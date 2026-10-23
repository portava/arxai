// ── AACI HARD SAFETY GATE — pure evaluator ──────────────────────────────────
//
// HARD_GATE is binary. H = product of all required binary factors. If any factor
// is 0, live action must be blocked. This is an ADVISORY mirror of the real
// safety stack — it NEVER replaces the authoritative gates (Risk Governor,
// 16-gate Phase B pipeline, kill switch, per-user approval). AACI can only ADD
// caution by failing this gate; it can never relax a real block.
//
// Returns clean machine reason codes (admin diagnostics) plus plain-English
// user messages. Raw internal names (canPlaceTrades, LIVE_LOCKED, command queue,
// API routes) are NEVER surfaced to regular users.

import type { AaciHardGateFactors, AaciHardGateFailure, AaciHardGateResult } from "./types";

// Ordered factor list: machine code + plain-English message shown to a user
// when the factor fails. Evaluated in this order so the primary failure
// (first listed) reflects the highest-priority safety concern.
const HARD_GATE_FACTOR_META: ReadonlyArray<{
  key: keyof AaciHardGateFactors;
  code: string;
  userMessage: string;
}> = [
  {
    key: "securityHandshakePass",
    code: "SECURITY_HANDSHAKE_FAILED",
    userMessage: "Security check failed. This action cannot continue right now.",
  },
  {
    key: "permission",
    code: "PERMISSION_MISSING",
    userMessage: "This action is not available for your account.",
  },
  {
    key: "riskPass",
    code: "RISK_GOVERNOR_BLOCK",
    userMessage: "Trading paused by risk controls.",
  },
  {
    key: "lossLimitPass",
    code: "LOSS_LIMIT_REACHED",
    userMessage: "A loss limit has been reached, so trading is paused.",
  },
  {
    key: "funded",
    code: "NOT_FUNDED",
    userMessage: "There are no allocated funds for this action.",
  },
  {
    key: "active",
    code: "AGENT_INACTIVE",
    userMessage: "This automated strategy is not currently active.",
  },
  {
    key: "autonomyAllowed",
    code: "AUTONOMY_NOT_ALLOWED",
    userMessage: "Automatic trading is not allowed for this action right now.",
  },
  {
    key: "bridgeReady",
    code: "BRIDGE_NOT_READY",
    userMessage: "The trading connection is unavailable.",
  },
  {
    key: "feedFresh",
    code: "FEED_STALE",
    userMessage: "Market data is refreshing.",
  },
  {
    key: "symbolTradable",
    code: "SYMBOL_NOT_TRADABLE",
    userMessage: "This market is not tradable right now.",
  },
  {
    key: "allocationAvailable",
    code: "ALLOCATION_UNAVAILABLE",
    userMessage: "There is not enough allocation available for this action.",
  },
  {
    key: "executionRouteReady",
    code: "EXECUTION_ROUTE_UNAVAILABLE",
    userMessage: "The trade route is not ready.",
  },
  {
    key: "auditReady",
    code: "AUDIT_UNAVAILABLE",
    userMessage: "Audit logging is unavailable, so automatic trading is paused.",
  },
];

/**
 * Evaluate the binary HARD_GATE. H = 1 only when every required factor is true.
 * Pure: identical inputs always produce identical output.
 */
export function evaluateAaciHardGate(factors: AaciHardGateFactors): AaciHardGateResult {
  const failures: AaciHardGateFailure[] = [];
  for (const meta of HARD_GATE_FACTOR_META) {
    if (!factors[meta.key]) {
      failures.push({ code: meta.code, userMessage: meta.userMessage });
    }
  }
  const pass = failures.length === 0;
  return { pass, value: pass ? 1 : 0, failures };
}

// Factors whose value is genuinely unknown should fail-open to CAUTION (false)
// for live-sensitive gates rather than silently passing. This helper builds a
// factor set from partial knowledge, defaulting any missing factor to `false`.
export function buildAaciHardGateFactors(
  partial: Partial<AaciHardGateFactors>,
): AaciHardGateFactors {
  return {
    securityHandshakePass: partial.securityHandshakePass ?? false,
    permission: partial.permission ?? false,
    funded: partial.funded ?? false,
    active: partial.active ?? false,
    autonomyAllowed: partial.autonomyAllowed ?? false,
    riskPass: partial.riskPass ?? false,
    lossLimitPass: partial.lossLimitPass ?? false,
    bridgeReady: partial.bridgeReady ?? false,
    feedFresh: partial.feedFresh ?? false,
    symbolTradable: partial.symbolTradable ?? false,
    allocationAvailable: partial.allocationAvailable ?? false,
    executionRouteReady: partial.executionRouteReady ?? false,
    auditReady: partial.auditReady ?? false,
  };
}
