# Broker-Absence Position Reconciler — Go/No-Go Checklist

_Last updated: 2026-06-07_

This document defines exactly what must be proven before
`BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` is set to `"true"`.
It is the authoritative pre-enablement gate for the Broker-Side Close
Reconciliation Guardrail.

---

## What the reconciler does (and doesn't do)

**Does:**
- Accumulates consecutive-reliable-absence evidence on `arx_live_positions` rows
  (`broker_absent_snapshot_count`, `first_broker_absent_at`, `last_broker_absent_at`,
  `last_reliable_snapshot_at`).
- After N ≥ 3 consecutive reliable absences AND a minimum first-absence age of
  120 s, stamps `closed_at` + `reconcile_state = RECONCILED_BROKER_ABSENT` on the
  row with a CAS guard.
- Writes a `BROKER_SIDE_CLOSE_RECONCILED` row to `live_trading_audit` for every
  stamped position.

**Never does:**
- Send a broker command or close a position on the broker's side.
- Stamp in a single sweep (N ≥ 3 consecutive reliable sweeps are required).
- Stamp from a partial or unreliable snapshot.
- Stamp across user or bridge isolation (strict per-user, per-bridge CAS).
- Race an in-flight ARX-initiated close (pending-close tickets are blocked).
- Auto-reconcile a position whose ticket is uncertain (no `broker_ticket` → blocked).

---

## Policy defaults (must NOT be changed before enabling)

| Parameter | Default | Meaning |
|---|---|---|
| `BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` | `false` | Master write gate. **Leave false** until this checklist is complete. |
| `requiredReliableAbsences` | 3 | Minimum consecutive reliable-sweep absences. |
| `minimumAbsentAgeMs` | 120 000 ms (2 min) | Minimum time since first absence before stamping. |
| `requireCompleteSnapshot` | `true` | Partial / degraded EA sweeps do not count. |
| `snapshotReliabilityWindowMs` | 60 000 ms (1 min) | Snapshot marker must be this fresh at stamp time. |

---

## Go/No-Go checklist

Work through every item. Mark PASS only when you have direct evidence.
Any FAIL or UNKNOWN blocks enablement.

### A. Pure-logic tests (offline)

| # | Check | Command | Expected |
|---|---|---|---|
| A1 | All pure-logic reconciler probes pass | `pnpm --filter @workspace/scripts run test:broker-absence-reconcile` | 12/12 PASS |
| A2 | Multi-cycle dry-run validation passes | `pnpm --filter @workspace/scripts run test:reconciler-dry-run-validation` | All passes, 0 failures |
| A3 | CI guards pass (invariants unchanged) | `pnpm run ci:guards` | 0 failures |

### B. Evidence-accumulation on real data (dry-run)

Run the admin dry-run endpoint for **all users with open live positions** and verify:

| # | Check | Evidence source | Expected |
|---|---|---|---|
| B1 | At least 3 consecutive reliable sweeps observed per eligible position | `GET /api/admin/reconciliation-center/broker-absence-candidates` — `absentSnapshotCount` column | `absentSnapshotCount ≥ 3` for every `wouldBeEligible` row |
| B2 | First-absent timestamp is at least 120 s old for every eligible position | Same endpoint — `firstAbsentAt` column | `now - firstAbsentAt ≥ 120 000 ms` for all eligible rows |
| B3 | No eligible row is missing a `brokerTicket` | Same endpoint — `mappingUncertain` column | `mappingUncertain = false` for every `safeToStampClosed = true` row |
| B4 | `noActiveBrokerPositionMisflagged = true` in aggregate report | Same endpoint — aggregate field | Must be `true` |
| B5 | No open live position that the broker shows as OPEN is flagged eligible | Cross-check `wouldBeEligible` rows against live broker position list via MT5 Setup | Zero matches between eligible candidates and currently-open broker positions |

### C. Classification correctness

| # | Check | Evidence source | Expected |
|---|---|---|---|
| C1 | V75 / synthetic index positions with confirmed tickets follow the same rules as forex | Dry-run report — symbol column | No special-cased exemption; same N + age gates apply |
| C2 | Positions with a pending ARX close command are blocked | Dry-run report — `blockedReason` column | `PENDING_ARX_CLOSE` for any position with a non-terminal `arx_live_commands.status` row |
| C3 | Already-closed and already-reconciled rows do not appear as fresh candidates | Dry-run report — candidates list | Zero `closedAt != null` or `reconcileState != null` candidates |

### D. Per-user isolation

| # | Check | Evidence source | Expected |
|---|---|---|---|
| D1 | No eligible candidate belongs to a different user than the scoped dry-run | `GET /api/admin/reconciliation-center/broker-absence-candidates?userId=<X>` — `userId` column on all samples | `userId` matches `X` for every sample |
| D2 | No eligible candidate crosses bridge connection scope when bridge-scoped | Same endpoint with `bridgeConnectionId` filter | `bridgeConnectionId` matches scope for every sample |

### E. Snapshot reliability

| # | Check | Evidence source | Expected |
|---|---|---|---|
| E1 | `snapshotReliable = true` during an active EA heartbeat session | Dry-run result — `snapshotReliable` field | `true` while EA is connected and sending position sweeps |
| E2 | `snapshotReliable = false` when EA heartbeat is stale / disconnected | Dry-run result — `snapshotReliable` field | `false`; no eligible rows possible (all blocked with `SNAPSHOT_UNRELIABLE`) |
| E3 | A single missing snapshot does NOT produce an eligible row | Inject one absent sweep then check the dry-run | `candidateState = accumulating_absence_evidence`, `safeToStampClosed = false` |

### F. Audit and CAS correctness

| # | Check | Evidence source | Expected |
|---|---|---|---|
| F1 | Every stamped row produces a `BROKER_SIDE_CLOSE_RECONCILED` audit row in `live_trading_audit` | Query `live_trading_audit` after enabling with a test position | 1:1 correspondence; no stamp without audit row |
| F2 | CAS re-asserts same ticket, same first-absent, same bridge, and `closedAt IS NULL` | Code review of `brokerAbsenceReconcileRunner.ts` → `stamped.length === 0` skips | The `WHERE` clause matches all five CAS conditions |
| F3 | A position that reappears between evaluation and stamp is NOT stamped | Simulate: evaluate → reappear sweep (count resets to 0) → attempt stamp | `stamped.length === 0` (CAS misses; count changed) |

### G. Write-gate safety

| # | Check | Evidence source | Expected |
|---|---|---|---|
| G1 | `POST /api/admin/reconciliation-center/broker-absence-reconcile` with `dryRun=false` while flag OFF returns `FEATURE_DISABLED` 409 | HTTP test | `{"ok":false,"error":"FEATURE_DISABLED"}` + audit row written |
| G2 | Write-path requires explicit bridge scope (unscoped POST rejected) | HTTP test with no `bridgeConnectionId` | 400 `BRIDGE_CONNECTION_ID_REQUIRED` |
| G3 | Grep confirms `BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` default is `false` in code | `grep -r "BROKER_ABSENCE_AUTO_RECONCILE_ENABLED" lib/ artifacts/` | Only one parse site in `brokerAbsencePolicy.ts`; default returned when unset is `false` |

---

## Enablement procedure (after all checks PASS)

1. Review this checklist with a second operator. Both must sign off.
2. Set `BROKER_ABSENCE_AUTO_RECONCILE_ENABLED="true"` in the target environment.
3. Restart the API server (the flag is parsed at startup).
4. Run the admin dry-run endpoint (`dryRun=false` is blocked until you are sure) one more time to confirm `enabled=true` in the policy snapshot.
5. Monitor `live_trading_audit` for `BROKER_SIDE_CLOSE_RECONCILED` events.
6. For any unexpected stamp, audit the row's `metadata.absentSnapshotCount`,
   `metadata.firstAbsentAt`, and `metadata.brokerTicket` to verify evidence is genuine.

---

## Rollback procedure

1. Unset `BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` (or set it to anything other than `"true"`).
2. Restart the API server.
3. The reconciler reverts to dry-run-only immediately.
4. Any positions already stamped `RECONCILED_BROKER_ABSENT` are **not** reversed
   automatically — they require a manual admin action via the reconciliation center
   (`resolve-manually` with a reason).

---

## Key files

| File | Role |
|---|---|
| `artifacts/api-server/src/lib/live/brokerAbsencePolicy.ts` | Policy + env flag parser (narrow `"true"`-only parser) |
| `artifacts/api-server/src/lib/live/brokerAbsenceReconcile.ts` | Pure decision surface (testable offline) |
| `artifacts/api-server/src/lib/live/brokerAbsenceReconcileRunner.ts` | DB runner + CAS stamp + audit row |
| `artifacts/api-server/src/routes/adminReconciliationCenter.ts` | Admin dry-run endpoint + manual trigger |
| `artifacts/api-server/src/routes/mt5Live.ts` (lines 385–414) | Evidence accumulation ingest path (on EA position sync) |
| `lib/db/src/schema/arxLiveExecution.ts` (lines 260–274) | Schema columns (`broker_absent_snapshot_count`, `first_broker_absent_at`, etc.) |
| `scripts/src/qaBrokerAbsenceReconcile.ts` | Pure-logic unit tests (12 checks, no DB) |
| `scripts/src/reconcilerDryRunValidationTest.ts` | Multi-cycle dry-run validation + aggregate report |
