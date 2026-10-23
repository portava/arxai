// ═══════════════════════════════════════════════════════════════════════════
// security/rateLimit.ts — pure sliding-window rate-limit + cooldown evaluator.
//
// Deterministic, no IO. The api-server persists `RateLimitState` (per
// action+scope) and calls this on every attempt. Each call represents ONE
// attempt and returns whether it is permitted plus the next state to store.
//
// SAFETY: a missing/unparseable state is treated as a fresh window (never an
// implicit grant of unlimited attempts); exceeding the limit always produces a
// cooldown, never a silent pass.
// ═══════════════════════════════════════════════════════════════════════════

import type { RateLimitRule } from "./operationalPolicies.js";

export interface RateLimitState {
  /** Attempts counted in the current window. */
  count: number;
  /** Epoch ms when the current window started. */
  windowStartedAt: number;
  /** Epoch ms until which attempts are locked out, or null when not locked. */
  blockedUntil: number | null;
}

export interface RateLimitDecision {
  /** True when THIS attempt is permitted. */
  allowed: boolean;
  /** True when the caller is in (or has just entered) a cooldown lock-out. */
  blocked: boolean;
  /** Milliseconds the caller should wait before retrying (0 when allowed). */
  retryAfterMs: number;
  /** Remaining attempts in the window after this one (0 when blocked). */
  remaining: number;
  /** The state the caller must persist for the next evaluation. */
  nextState: RateLimitState;
  /** Stable machine reason. */
  reason: "OK" | "RATE_LIMIT_EXCEEDED" | "RATE_LIMIT_COOLDOWN_ACTIVE";
}

/**
 * Evaluate one attempt against a rule. Pure: identical (prev, rule, now) inputs
 * always produce identical output.
 */
export function evaluateRateLimit(
  prev: RateLimitState | null | undefined,
  rule: RateLimitRule,
  now: number,
): RateLimitDecision {
  // Already locked out — do not consume, just report remaining cooldown.
  if (prev?.blockedUntil != null && now < prev.blockedUntil) {
    return {
      allowed: false,
      blocked: true,
      retryAfterMs: prev.blockedUntil - now,
      remaining: 0,
      nextState: prev,
      reason: "RATE_LIMIT_COOLDOWN_ACTIVE",
    };
  }

  let windowStartedAt = prev?.windowStartedAt ?? now;
  let count = prev?.count ?? 0;

  // Window expired (or a stale cooldown elapsed) → start fresh.
  if (now - windowStartedAt >= rule.windowMs) {
    windowStartedAt = now;
    count = 0;
  }

  count += 1;

  if (count > rule.limit) {
    const blockedUntil = now + rule.cooldownMs;
    return {
      allowed: false,
      blocked: true,
      retryAfterMs: rule.cooldownMs,
      remaining: 0,
      nextState: { count, windowStartedAt, blockedUntil },
      reason: "RATE_LIMIT_EXCEEDED",
    };
  }

  return {
    allowed: true,
    blocked: false,
    retryAfterMs: 0,
    remaining: Math.max(0, rule.limit - count),
    nextState: { count, windowStartedAt, blockedUntil: null },
    reason: "OK",
  };
}
