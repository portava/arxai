---
name: Allocation shell sync invariants
description: Rules for keeping virtual_trading_accounts.virtualBalance consistent with user_slot_allocation when admin mutates allocations.
---

# Rule
Every admin allocation mutator (/add, /set, /remove, /transfer) that calls a shell-sync helper MUST pass a delta derived from the persisted post-round value, not the raw request input.

- `/add`: sync `round2(newTotalAfter − base.total)`, not the raw `amount`.
- `/set`: compute `persistedAmount = round2(amount)` once and use it for capacity check, persistence, sync delta, and audit.
- `/remove`, `/transfer`: same pattern — derive delta from the row you actually wrote.

**Why:** Sub-cent noise on a non-2dp input (e.g. `1.005`) that slips past Zod will otherwise drift the user's shell from `user_slot_allocation` by fractions of a cent each call, and the drift is invisible until a Synced/Drift chip flips. The persisted value is the only source of truth — the request body is not.

**How to apply:** When adding a new mutator endpoint in `artifacts/api-server/src/routes/adminAllocations.ts`, write the new `allocatedFunds` first, then compute `delta = round2(newAllocated − base.total)` and pass that to `syncVirtualBalanceDeltaInTx`. Mirror it in the audit `afterState.delta` so audit and shell agree.

# Related
- `syncVirtualBalanceDeltaInTx` is a no-op when the user has no VTA row — orphan users do not get a shell materialised by GET or by mutation alone; attach is the only path that creates one.
- `virtualPnl` is owned by `virtualPnlSync` from closed trades; admin allocation actions must never overwrite it.
- `ensureSharedMasterAccountInTx` uses `onConflictDoNothing({target: connectionId})` + re-read to survive concurrent first-time attaches against the `shared_master_accounts_connection_uidx` unique index.
- Detach and refresh-shell routes are demo-scoped (`accountType='demo'`) — admin allocation routes do not touch a user's live virtual row.
