# T014 — Live-readiness repair (two real blockers)

This runbook records the two honest repairs that cleared the owner's
(user id 4, `andraie.co@gmail.com`, OWNER) live-readiness blockers.
**No safety gate was bypassed, removed, or weakened. No funds were
invented. No account type was spoofed.** The authoritative audit record is
the `admin_action_audit_log` row written by the reconciliation transaction;
this file is the human-readable companion.

## Blocker 1 — `LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED` (data, not gate)

**Root cause.** The owner has `user_slot_allocation` (id 10) with
`allocated_funds = 7`. Two stale `arx_live_positions` rows (ids 1 & 2, Deriv
synthetic indices "Volatility 75/25 (1s) Index", `last_synced_at`
2026-05-22 / 2026-05-27) still had `closed_at IS NULL` and carried frozen
floating losses summing **-80.95**. `getUserAllocationView`
(`masterBridgePool.ts`) subtracts open floating loss from rows where
`closed_at IS NULL`, so `availableAllocation = max(0, 7 - 0 + (-80.95)) = 0`.

The positions were **closed at the broker manually** (no ARX
`CLOSE_LIVE_POSITION` LIVE_FILLED command), so the ghost-close reconciler in
`mt5Live.ts` (`sync-live-positions`) — which only closes tickets that have a
matching LIVE_FILLED close command — never fired. No existing admin endpoint
covers an **owned, broker-confirmed-gone** position (orphan endpoints target
unattributed rows; `/close` sends a real broker CLOSE that would fail on an
already-closed ticket).

**Broker truth (bridge 287, current heartbeat).** `margin = 0` and
`equity == balance == 9.52 USD` ⟹ **zero open positions at the broker**.
(Open positions always consume margin; any open floating P/L would make
`equity ≠ balance`. Three independent signals — margin 0, equity==balance,
rows unsynced >4 days while heartbeat is live — confirm the rows are phantom.)

**Repair (one-time audited data reconciliation).** A single transaction:
- `UPDATE arx_live_positions SET closed_at = now(), last_synced_at = now(),
  reconcile_state = 'ADMIN_RECONCILED_BROKER_CLOSED', reconcile_note = '…',
  reconciled_by_admin_id = 4, reconciled_at = now()`
  guarded by `WHERE id IN (1,2) AND user_id = 4 AND closed_at IS NULL`.
- `INSERT INTO admin_action_audit_log (...)` with
  `action = 'LIVE_POSITION_RECONCILED_BROKER_CLOSED'`, `admin_role = 'OWNER'`,
  `target_user_id = 4`, before/after JSON, and a reason citing the broker
  evidence.

**Verification.** Owner `availableAllocation` → 7; per-user open floating
loss → 0; `arx_master_bridge_pool` recomputed to
`total_user_unrealized_pnl = 0`, `allocation_deficit = 0`,
`is_over_allocated = false`, `snapshot_status = FRESH`. The allocation gate
in `liveCommandPipeline.ts` is unchanged.

> `reconcile_state` value `ADMIN_RECONCILED_BROKER_CLOSED` is distinct from
> the orphan flow values (`IGNORED` / `EXTERNAL` / `IMPORTED`) so an operator
> can tell an owner-reconciled broker-close apart from an orphan decision.

## Blocker 2 — `ea_account_type = FAIL` (display bug, not gate)

**Root cause.** The real dispatch gate #6
(`livePhaseBDispatchGate.ts`) normalises the bridge account type with
`.toLowerCase()` and accepts `live`/`real` — it **PASSES** for the EA's
lowercase `"live"`. The admin diagnostic
(`adminLiveGatesDiagnostic.ts`) compared case-**sensitively**
(`=== "LIVE" || === "REAL"`) and so displayed **FAIL** for `"live"`, a pure
readout bug. The account is genuinely live.

**Fix.** The `ea_account_type` diagnostic row now normalises with
`.trim().toLowerCase()` and accepts `live`/`real`, matching gate #6. Raw
account type stays admin-only (route is `requireAdmin`). No gate behaviour
changed. Coverage: the existing `test:live-phaseB` suite already locks the
gate semantics (lowercase `"live"` baseline PASSes; `"demo"` →
`BRIDGE_NOT_LIVE_ACCOUNT`).
