// Canonical safety vocabulary for the live-execution hard-lock.
//
// Phase 10 rename: the lock that prevents live broker dispatch until every
// readiness gate passes used to be called the "paper-only hard lock".
// That name implied a product mode ("Paper Trading") which has been removed
// (Phases 2/3). The lock itself is unchanged — it still blocks live
// dispatch until all gates pass — but its accurate name is the
// LIVE_EXECUTION hard-lock.
//
// New canonical names (use these in all new code):
//   - liveExecutionHardLockActive    (boolean)
//   - LIVE_EXECUTION_HARD_LOCK_REASON  ("LIVE_EXECUTION_LOCKED")
//   - LiveExecutionLockSnapshot      (response shape)
//
// Deprecated aliases retained for backward compatibility:
//   - paperOnlyHardLockActive (boolean) — emitted in API responses
//     alongside the new field so existing frontend clients and assistant
//     tools keep working until the next contract bump. Server-side
//     readers should prefer the new name.
//
// Wire-level literals INTENTIONALLY preserved (not in scope for Phase 10):
//   - safetyMode: "paper_only"         — pinned by DB column default
//     (lib/db/src/schema/mt5Commands.ts safety_mode), 30+ route
//     response envelopes, CI guards (scripts/src/ci/*) that regex this
//     exact string, generated zod schemas (lib/api-zod), and the
//     frontend realtime-voice mint validator. Renaming requires a
//     coordinated DB migration + codegen regen + CI guard update +
//     frontend safety check update. Tracked for a future phase.
//   - CanonicalBridgeMode "PAPER_ONLY" — legacy bridge-mode normalizer
//     canonical value (lib/domain/src/safety-contracts/bridgeMode.ts).
//     Semantic meaning is "paper-account routing" (executionMode
//     concept), not the removed "Paper Trading" product mode.
//   - Domain PAPER_ONLY enum values in killSwitch, permissionThrottle,
//     personalRiskPrescription, executionAi, replay-lab — these are
//     "downgrade to simulation" recovery actions, not product modes.

export const LIVE_EXECUTION_HARD_LOCK_REASON = "LIVE_EXECUTION_LOCKED" as const;

export type LiveExecutionHardLockReason = typeof LIVE_EXECUTION_HARD_LOCK_REASON;

/** Snapshot of the live-execution hard-lock state. */
export interface LiveExecutionLockSnapshot {
  /** True when live broker dispatch is locked at the platform layer. */
  liveExecutionHardLockActive: boolean;
  /**
   * Deprecated alias for `liveExecutionHardLockActive`. Kept for
   * back-compat until contract bump. New callers must use the
   * canonical field.
   * @deprecated Use `liveExecutionHardLockActive`.
   */
  paperOnlyHardLockActive: boolean;
}

/**
 * Build a snapshot from a single boolean. Emits BOTH the canonical and
 * the deprecated field so existing API consumers continue to work.
 */
export function buildLiveExecutionLockSnapshot(
  active: boolean,
): LiveExecutionLockSnapshot {
  return {
    liveExecutionHardLockActive: active,
    paperOnlyHardLockActive: active,
  };
}
