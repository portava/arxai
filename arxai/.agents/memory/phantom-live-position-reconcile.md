---
name: Reconciling phantom owned live positions
description: How to safely clear stale open arx_live_positions that drag a user's live allocation to 0, when the broker shows them already closed.
---

Symptom: a live-approved user is blocked with `LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED`
even though their `user_slot_allocation.allocated_funds` is positive.

Root cause to check first: `getUserAllocationView` (masterBridgePool.ts) computes
`availableAllocation = max(0, allocated - assigned + sum(negative floating_pl of OPEN rows))`,
where "open" = `arx_live_positions.closed_at IS NULL`. A stale row that is still
open in ARX but already closed at the broker keeps subtracting its frozen
floating loss forever, pinning available to 0.

How to confirm the rows are truly phantom — the AUTHORITATIVE test is snapshot
presence, not the margin/equity heuristic:
- A row is broker-confirmed-gone iff it is ABSENT from the latest full EA
  positions snapshot. Concretely: `last_synced_at < mt5_connection.last_positions_snapshot_at`
  (give ~60s skew) while the heartbeat is fresh. Rows still on the broker get
  their `last_synced_at` bumped to the snapshot time every sync.
- Weaker corroboration (do NOT rely on alone): heartbeat `margin = 0`, and
  `equity ≈ balance`. CAVEAT: these FAIL when ≥1 real position is still open —
  e.g. balance 721.55 / equity 673.35 looked "unequal" only because exactly one
  genuine open position (floating −48) remained; the other 82 were still phantom.
  Always partition by snapshot presence, then `equity == balance + Σ floating of
  the rows that ARE in the snapshot` is the consistency check.

Why there is no built-in fix: the ghost-close reconciler in mt5Live.ts
(`sync-live-positions`) only closes tickets that have a matching LIVE_FILLED
`CLOSE_LIVE_POSITION` command. A position closed *manually at the broker* never
gets one, so it never auto-reconciles. Orphan admin endpoints target
*unattributed* rows; `/close` sends a real broker CLOSE that fails on an
already-closed ticket. So an **owned, broker-confirmed-gone** position has no
endpoint.

Correct fix (NOT a bypass): one audited transactional data repair —
`UPDATE arx_live_positions SET closed_at=now(), reconcile_state='ADMIN_RECONCILED_BROKER_CLOSED',
reconcile_note=..., reconciled_by_admin_id=..., reconciled_at=now()`
guarded by `WHERE id IN (...) AND user_id=<owner> AND closed_at IS NULL`, plus an
`admin_action_audit_log` row (before/after/reason citing the broker evidence).
This corrects the ledger to broker truth; the allocation gate code is untouched.
Do NOT raise allocated_funds, fake balance, or relax the gate. After the repair,
the master pool recomputes (`total_user_unrealized_pnl` → 0) on the next sync.

**How to apply:** stamp a non-null `reconcile_state` distinguishable from orphan
flow values (IGNORED/EXTERNAL/IMPORTED). Prefer the schema-canonical, runner-used
value `RECONCILED_BROKER_ABSENT`. NOTE: `ADMIN_RECONCILED_BROKER_CLOSED` is ALSO
present in this DB from an earlier manual repair (it is real, not a mistake — do
not "fix" it away); it just isn't the enumerated/runner value. Both are excluded
from exposure by the `reconcile_state IS NOT NULL` predicate, so either reads
correctly — but new repairs should use `RECONCILED_BROKER_ABSENT` for
consistency with the auto-runner. Never auto-close on a margin/equity heuristic
in the sync path — ALERT_ONLY is an inviolable invariant; this is a one-time
operator data correction, not automated closing.

## EA-offline variant — gate on broker DIRECT evidence, not a fresh snapshot

The snapshot-presence test (and the auto broker-absence runner) requires a FRESH
EA positions snapshot (`last_positions_snapshot_at` within ~60s). When the
external EA is OFFLINE (heartbeat + snapshot frozen), that gate can never fire by
design, so the runner reconciles nothing. For that case use the one-time script
`artifacts/api-server/src/scripts/reconcileOwnerPhantomLiveByBrokerState.ts`
(npm `reconcile:owner-phantom-broker-state`, dry-run default, `--apply`,
`--user=` required, `--bridge=` optional). It reuses the canonical pure
`findBrokerAbsentGhostPositionIds` + the runner's CAS stamp guard +
`RECONCILED_BROKER_ABSENT` + per-position `liveTradingAudit`
`BROKER_SIDE_CLOSE_RECONCILED` row, but gates SAFE_TO_STAMP on the broker's
DIRECT heartbeat evidence (`accountType` live AND `margin == 0` AND
`|equity - balance| <= 0.01`) instead of snapshot freshness. `--apply` also
calls `sweepExpiredLiveCommands({userId})` (clears stuck `SENT_TO_MT5_LIVE`
commands → `LIVE_EXPIRED`) and writes one summary `admin_action_audit_log` row.
**Why this is honest, not a heuristic shortcut:** the weak margin/equity caveat
above only fails when ≥1 REAL position is still open — when the broker reports
margin 0 AND equity == balance, there is provably no open position at the broker,
so every still-open ARX row is a ghost. No gate is weakened; this only corrects
the ledger to broker truth. Do NOT use this variant while real positions are
open (margin>0 or equity≠balance) — fall back to snapshot partitioning.

## Every exposure/gating read of arx_live_positions must exclude reconciled rows

`closed_at IS NULL` alone is NOT "open for exposure purposes." A reconciled row
(`reconcile_state IS NOT NULL` — IGNORED/EXTERNAL/IMPORTED or
ADMIN_RECONCILED_BROKER_CLOSED) is broker-confirmed gone even if `closed_at` was
never stamped (the orphan flow sets `reconcile_state` without closing). Any read
that sums floating P/L or counts open positions for **exposure, the master pool,
or an execution gate** MUST filter `AND reconcile_state IS NULL`, mirroring
`getUserAllocationView`. **Why:** `recomputeMasterPool` (pool unrealized P/L /
is_over_allocated) and the Self-Trade `executionGate` floating read each filtered
only `closed_at IS NULL`, so 15 IGNORED ghosts on a dead bridge inflated pool
unrealized P/L by ~$2079 while the user-facing headroom (which already filtered
reconcile_state) was correct — a silent read-vs-read inconsistency. **How to
apply:** when adding ANY new open-position read for exposure/gating, copy the
`isNull(closedAt) AND isNull(reconcileState)` pair, not just `closedAt`. Pure
display/history reads may keep showing reconciled rows.

## Centralize the exposure predicate in ONE shared fn

Don't re-type `isNull(closedAt) AND isNull(reconcileState)` at each call site — it
drifts (a new read forgets the reconcile_state half and a ghost re-inflates).
There is now ONE source of truth: `openLiveExposureCondition(userId?)` in
`artifacts/api-server/src/lib/live/livePositionExposure.ts` (returns
`and(isNull(closedAt), isNull(reconcileState), userId? eq(userId): undefined)`).
Every exposure/gate read routes through it: masterBridgePool recompute +
allocationView, selfTrade executionGate (composed with `inArray(brokerTicket)`),
adminAllocations getUserPnl + settled-detection + detach-block, meLiveAccount,
adminLiveAccount per-user totals. **How to apply:** any NEW open-position read for
exposure/gating imports this predicate; never inline the pair. Pure
display/history/orphan-detection reads stay OUT (they must see reconciled rows).

## One-time owner phantom reconcile — reuse the runner, don't flip env

To clear a backlog of broker-absent ghosts for one user WITHOUT enabling the
global auto-runner: call the existing `runBrokerAbsenceReconcile({ userId,
bridgeConnectionId, dryRun, policy: {...brokerAbsenceAutoReconcilePolicy,
enabled:true} })` with a LOCAL policy override (this invocation only — never
mutates env `BROKER_ABSENCE_AUTO_RECONCILE_ENABLED` or starts the background
runner). CLI: `artifacts/api-server/src/scripts/reconcileOwnerPhantomLivePositions.ts`
(npm `reconcile:owner-phantom-live`), dry-run-first, `--apply` required,
`--user=` required, `--bridge=` optional. Writes go through the runner's CAS +
`BROKER_SIDE_CLOSE_RECONCILED` audit — same path as auto-mode, no 2nd close path.
It stamps `closed_at` + `reconcile_state='RECONCILED_BROKER_ABSENT'`; real-open
rows (in latest snapshot ⇒ absence count 0 ⇒ ACCUMULATING_ABSENCE_EVIDENCE) are
auto-protected. Idempotent (re-run matches nothing). **Why:** the runner's write
branch only fires on `!dryRun && policy.enabled && bridgeConnectionId != null`.

**Bridge auto-resolve trap (NULLS FIRST):** resolving "freshest connected
non-demo bridge" with `ORDER BY last_positions_snapshot_at DESC` picks a
NEVER-SYNCED bridge (NULL marker) because Postgres sorts NULLs FIRST under DESC —
the runner then scopes to a connection with no truth (snapshotReliable=false ⇒ 0
candidates). MUST use `DESC NULLS LAST` (or prefer the bridge that actually holds
the open rows).
