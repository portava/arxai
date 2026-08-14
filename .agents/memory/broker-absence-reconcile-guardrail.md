---
name: Broker-absence close-reconcile guardrail
description: Safety rules for auto-stamping closed_at on arx_live_positions when a position is absent across broker sweeps.
---

# Broker-Side Close Reconciliation Guardrail

Stamps `closed_at` + `reconcileState='RECONCILED_BROKER_ABSENT'` on `arx_live_positions`
ONLY when a position is absent across N≥3 consecutive RELIABLE complete broker sweeps
(min absent age ~120s). Never closes on one missing snapshot; never sends a broker command;
DB-write is gated behind `BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` (narrow true-only parser),
default OFF (dry-run first).

## Two non-obvious correctness rules (from architect review)

- **The stamp CAS must re-assert the absence evidence, not just `closedAt IS NULL`.**
  Reconcile runs fire-and-forget after each snapshot, so a re-confirming snapshot can land
  between evaluation and the UPDATE. The CAS WHERE must pin the evaluation-time evidence:
  same `brokerTicket`, same `firstBrokerAbsentAt`, `brokerAbsentSnapshotCount >= required`,
  same `bridgeConnectionId`, plus `closedAt/reconcileState IS NULL`.
  **Why:** a re-appeared position resets count→0 / firstAbsent→null (and a new absence cycle
  gets a *new* firstAbsent), so an evidence-pinned CAS fails-to-match and skips — a CAS that
  only checks `closedAt IS NULL` would happily close a position the broker re-confirmed open.

- **Writes must be bridge-scoped; dry-run may be unscoped.** Snapshot reliability is derived
  from the freshest sweep marker. With no `bridgeConnectionId` the marker is the freshest
  across ALL of the user's bridges, so a fresh bridge B can make a stale bridge A row look
  reliable. The DB runner only stamps when `bridgeConnectionId != null`; the admin manual POST
  returns `400 BRIDGE_CONNECTION_ID_REQUIRED` for `dryRun=false` without one. Auto-run from
  ingest is always per-bridge so it's fine.

## Diagnostic signature: "reconciler didn't reconcile" almost always = flag OFF
Evidence ACCUMULATION (nextAbsenceEvidence: counter++ / firstBrokerAbsentAt) runs
on every reliable+complete snapshot REGARDLESS of the flag; only the WRITE path is
gated. So the classic phantom-pileup signature is: open rows (closed_at NULL,
reconcile_state NULL) with `broker_absent_snapshot_count` in the hundreds/thousands
and `first_broker_absent_at` days old, while `last_reliable_snapshot_at` is seconds
fresh — i.e. ALL evidence gates pass overwhelmingly and nothing was ever stamped.
That is NOT a stuck runner and NOT "waiting on a confirmation it can't get": the
reconciler uses ONLY absence-from-the-open-positions-snapshot, never deal-history.
The runner is invoked at `mt5Live.ts` ONLY inside `if (policy.enabled)`, so flag
OFF = runner never called. A high-but-NON-RESET count also proves every recent
sweep was reliable+complete (any unreliable/partial sweep resets the count to 0).
Check the flag first; don't go hunting for a missing confirmation.

## closeAt is estimated
`chooseReconciledCloseAt` prefers `firstBrokerAbsentAt` (the broker's last-seen→first-absent
boundary). It's an estimate, audited with that provenance — the exact broker close time is
unknown because the EA only pushes the open-position list, never a close event.
