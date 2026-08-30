// Phase 6 — close reconciliation.
//
// Carries VENUE-CONFIRMED settlements back into the guided ledger. Until this
// existed, an EXECUTED attempt stayed OPEN forever (the honest ratchet), the
// position centre could not truthfully say "Closed", and the loss-streak gate
// was inert for want of settled P/L.
//
// THE FORBIDDEN INFERENCES, restated for this worker specifically:
//   - absence from a portfolio read is NOT a close;
//   - a failed venue read is NOT a close (the attempt simply stays OPEN);
//   - a venue reply about a DIFFERENT contract is NOT evidence about this one;
//   - a settled contract with no stated profit is settled with UNSTATED P/L —
//     null, never zero, never derived from stop levels.
//
// The worker only ever APPENDS one RECONCILED event per attempt, and the
// at-most-once property is enforced by a partial unique index in the database
// (guided_attempt_events_reconciled_uq), not by application discipline.
//
// Pure orchestration: every dependency is injected so the logic is testable
// and mutation-provable without a database or a venue.

export interface UnreconciledAttempt {
  intentId: string;
  ticketId: string;
  venueContractRef: string | null;
  constitutionVersion: number;
}

/** What the venue said about one contract, or why it could not be asked. */
export type VenueContractRead =
  | { kind: "SETTLED"; contractId: string; profit: number | null }
  | { kind: "OPEN"; contractId: string }
  | { kind: "UNREADABLE"; detail: string };

export interface CloseReconcilerDeps {
  listUnreconciled: (userId: number) => Promise<UnreconciledAttempt[]>;
  readContract: (venueContractRef: string) => Promise<VenueContractRead>;
  appendReconciled: (r: {
    intentId: string;
    ticketId: string;
    userId: number;
    constitutionVersion: number;
    venueContractRef: string;
    venueProfitUsd: number | null;
    detail: string;
  }) => Promise<"appended" | "already">;
}

export interface CloseReconcilerReport {
  /** Venue confirmed settled; RECONCILED appended this run. */
  reconciled: Array<{ intentId: string; venueContractRef: string; venueProfitUsd: number | null }>;
  /** Venue confirmed settled; another run had already recorded it. */
  alreadyReconciled: string[];
  /** Venue says the position is still open. Nothing written. */
  stillOpen: string[];
  /** The venue could not be read for this attempt. Nothing written. */
  unreadable: Array<{ intentId: string; detail: string }>;
  /**
   * Anomalies a human must see: an EXECUTED attempt with no contract ref
   * (should be impossible — EXECUTED requires one), or a venue reply about a
   * different contract than the one asked about. Nothing written.
   */
  anomalies: Array<{ intentId: string; detail: string }>;
}

export async function reconcileGuidedClosures(
  userId: number,
  deps: CloseReconcilerDeps,
): Promise<CloseReconcilerReport> {
  const report: CloseReconcilerReport = {
    reconciled: [], alreadyReconciled: [], stillOpen: [], unreadable: [], anomalies: [],
  };

  const work = await deps.listUnreconciled(userId);
  for (const attempt of work) {
    const ref = attempt.venueContractRef;
    if (typeof ref !== "string" || ref.trim() === "") {
      report.anomalies.push({
        intentId: attempt.intentId,
        detail: "EXECUTED attempt carries no venue contract reference — lineage invariant violated upstream",
      });
      continue;
    }

    let read: VenueContractRead;
    try {
      read = await deps.readContract(ref);
    } catch (e) {
      read = { kind: "UNREADABLE", detail: e instanceof Error ? e.message : String(e) };
    }

    if (read.kind === "UNREADABLE") {
      report.unreadable.push({ intentId: attempt.intentId, detail: read.detail });
      continue;
    }
    if (read.contractId !== ref) {
      // A reply about a different contract proves nothing about this one and
      // hints at a read-layer defect. Refuse to write on someone else's fact.
      report.anomalies.push({
        intentId: attempt.intentId,
        detail: "venue replied about a different contract than the one asked about",
      });
      continue;
    }
    if (read.kind === "OPEN") {
      report.stillOpen.push(attempt.intentId);
      continue;
    }

    // SETTLED, about the right contract. The one write this worker makes.
    const profit = read.profit;
    const outcome = await deps.appendReconciled({
      intentId: attempt.intentId,
      ticketId: attempt.ticketId,
      userId,
      constitutionVersion: attempt.constitutionVersion,
      venueContractRef: ref,
      venueProfitUsd: profit,
      detail: profit === null
        ? "venue-confirmed settled; the venue stated no realized P/L (recorded as unstated, not zero)"
        : `venue-confirmed settled; Deriv-reported realized P/L ${profit}`,
    });
    if (outcome === "appended") {
      report.reconciled.push({ intentId: attempt.intentId, venueContractRef: ref, venueProfitUsd: profit });
    } else {
      report.alreadyReconciled.push(attempt.intentId);
    }
  }

  return report;
}
