// Broker-Side Close Reconciliation Guardrail — policy / feature flag.
//
// SAFETY: this controls whether the broker-absence reconciler is allowed to
// WRITE (stamp closed_at + reconcileState=RECONCILED_BROKER_ABSENT) on
// `arx_live_positions`. It defaults to DISABLED. While disabled the system
// still ACCUMULATES absence evidence (counter columns) and exposes admin
// dry-run visibility, but never mutates closed_at. Enable only after the
// dry-run output and reconciliation detector have been reviewed against real
// data (see ROLLOUT GUIDANCE in the build spec).
//
// Even when enabled this NEVER sends a broker command, NEVER auto-closes on a
// single missing snapshot, and NEVER crosses user/bridge isolation.

// Narrow env parser — accept ONLY a trimmed, lowercased "true". Mirrors the
// project-wide convention for safety switches (never broaden to 1/yes/on).
function parseEnabledFlag(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

export interface BrokerAbsenceReconcilePolicy {
  /** Master switch for the DB-WRITE path. Default false (dry-run only). */
  enabled: boolean;
  /** Consecutive reliable absences required before a row is stamp-eligible. */
  requiredReliableAbsences: number;
  /** Minimum age of the FIRST absence before stamping (anti-flap guard). */
  minimumAbsentAgeMs: number;
  /** A snapshot must be a complete sweep (not partial/degraded) to count. */
  requireCompleteSnapshot: boolean;
  /**
   * The latest snapshot marker must be within this window at stamp time, or we
   * have no reliable current broker truth and refuse to stamp. Matches the
   * position-freshness reliability window used by the display layer.
   */
  snapshotReliabilityWindowMs: number;
}

export const brokerAbsenceAutoReconcilePolicy: BrokerAbsenceReconcilePolicy = {
  enabled: parseEnabledFlag(process.env["BROKER_ABSENCE_AUTO_RECONCILE_ENABLED"]),
  requiredReliableAbsences: 3,
  minimumAbsentAgeMs: 120_000,
  requireCompleteSnapshot: true,
  snapshotReliabilityWindowMs: 60_000,
};

// ── OBSERVATION vs ACTION (outcome-truth defect) ─────────────────────────────
//
// The flag above gates an ACTION: mutating `arx_live_positions` (stamping
// closed_at + reconcileState) on rows ARX did not close. That is state ARX
// writes about the broker, so it stays behind an explicit switch.
//
// RECORDING THE OUTCOME OF AN ALREADY-CLOSED POSITION IS NOT AN ACTION. The
// broker closed the trade — by its stop-loss, by a stop-out, by hand — before we
// looked. Writing down what already happened changes nothing at the broker and
// cannot place, modify, or relax anything. Leaving it behind the action flag is
// what produced the upward bias: ARX-issued closes (wins, take-profits, trails)
// were recorded and broker-side stop-losses were not.
//
// So observation runs ALWAYS, on the SAME evidence bar as the action (N
// consecutive reliable COMPLETE sweeps + a minimum first-absence age, so a
// flapping snapshot can never manufacture a close). `enabled: true` here means
// only "keep observing"; the observer writes no position state and issues no
// broker command. When the broker gives us no numbers, the recorded outcome is
// an honest UNRECONCILED with pnl null — never an inferred price or P/L.
export const brokerCloseObservationPolicy: BrokerAbsenceReconcilePolicy = {
  enabled: true,
  requiredReliableAbsences: brokerAbsenceAutoReconcilePolicy.requiredReliableAbsences,
  minimumAbsentAgeMs: brokerAbsenceAutoReconcilePolicy.minimumAbsentAgeMs,
  requireCompleteSnapshot: brokerAbsenceAutoReconcilePolicy.requireCompleteSnapshot,
  snapshotReliabilityWindowMs: brokerAbsenceAutoReconcilePolicy.snapshotReliabilityWindowMs,
};
