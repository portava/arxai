// livePreflightReadinessObservation.ts
//
// Task #785 (option 2) — additive/observational consumption of the unified
// live-readiness resolver by the server-side live dispatch PREFLIGHT.
//
// This module is PURE and DECISION-FREE. It folds the unified resolver verdict
// (`buildUnifiedLiveReadiness`) together with the preflight's own canonical
// outcome into a single observational record for diagnostics/logging. It is
// NOT a gate:
//   * It NEVER turns a blocked preflight into a pass (no bypass).
//   * It NEVER turns a passing preflight into a block (the 23-gate dispatch and
//     the existing preflight gates remain the sole authority).
//   * It only REPORTS — so an operator can see when the unified resolver and the
//     canonical preflight disagree (drift), and which extra blockers the unified
//     resolver sees that the preflight let pass.
//
// The preflight calls this strictly for observability; the returned object is
// logged, never branched on for the dispatch decision.

import type {
  LiveReadinessBlocker,
  UnifiedLiveReadiness,
} from "./unifiedLiveReadinessDecision.js";

export interface LivePreflightReadinessObservation {
  /** Structural marker: this record can only describe, never decide. */
  readonly observationOnly: true;
  /** The canonical preflight outcome (the ONLY authority for the draft). */
  readonly preflightBlocked: boolean;
  readonly preflightReason: string | null;
  /** Whether the unified resolver could be built (false => fail-soft/no read). */
  readonly unifiedResolved: boolean;
  /** Readiness HINT from the unified resolver — never used to grant execution. */
  readonly unifiedLiveEntryEligible: boolean;
  /** Every blocker code the unified resolver reported (multi-blocker honesty). */
  readonly unifiedBlockerCodes: string[];
  /**
   * Blockers the unified resolver reports while the preflight PASSED. Pure
   * diagnostics: these are surfaced so drift is visible, but they do NOT block
   * the draft (the canonical preflight + the 23-gate dispatch decide that).
   */
  readonly additionalBlockersNotInPreflight: LiveReadinessBlocker[];
  /** TRUE when the preflight passed but the unified resolver still sees a block. */
  readonly unifiedReportsAdditionalBlock: boolean;
}

/**
 * Build the observational readiness record. Pure, deterministic, db-free.
 *
 * `unified` is null when the resolver could not be built (fail-soft) — the
 * observation then simply records `unifiedResolved: false` and changes nothing
 * about the preflight outcome.
 */
export function buildLivePreflightReadinessObservation(args: {
  preflightBlocked: boolean;
  preflightReason: string | null;
  unified: UnifiedLiveReadiness | null;
}): LivePreflightReadinessObservation {
  const { preflightBlocked, preflightReason, unified } = args;
  const blockers = unified?.blockers ?? [];
  // Additional (drift) blockers only make sense when the preflight PASSED — a
  // blocked preflight is already refusing, so there is nothing "additional".
  const additionalBlockersNotInPreflight = preflightBlocked ? [] : blockers;
  return {
    observationOnly: true,
    preflightBlocked,
    preflightReason,
    unifiedResolved: unified != null,
    unifiedLiveEntryEligible: unified?.liveEntryEligible ?? false,
    unifiedBlockerCodes: blockers.map((b) => b.code),
    additionalBlockersNotInPreflight,
    unifiedReportsAdditionalBlock: !preflightBlocked && blockers.length > 0,
  };
}
