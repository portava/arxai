---
name: Fund Book drawdown / high-water engine reconciliation
description: Two invariants the periodic HWM recompute must hold to avoid stale drawdowns and snapshot tears.
---

The Fund Book drawdown engine (`artifacts/api-server/src/lib/fundbook/drawdownEngine.ts`)
recomputes high-water + drawdown rows at MASTER/POOL/INVESTOR/BROKER/TRADE scopes
into `fund_book_high_water_marks`.

Rule 1 — one consistent snapshot. Every input (pools, NAV, holdings, connections,
floating overlay) must be read through the SAME transaction handle. The broker-mirror
read helpers (`getOpenPositionsWithPools`, `getPoolFloatingPl` in `brokerMirror.ts`)
accept an optional `DbReader = Pick<typeof db,"select">` (both `db` and a `Tx` satisfy it),
so the engine passes its `tx`. Reading the overlay via the global `db` while everything
else is on `tx` tears the snapshot under concurrent updates.

**Why:** scopes computed from mixed-time reads produce drawdowns that never reconcile.

Rule 2 — reconcile away vanished scopes. HWM rows are advance-only (peak holds), so a
scope that disappears from the live snapshot (closed/now-null-floating trade, removed
bridge, fully-redeemed investor whose holding goes status=CLOSED and drops from the
ACTIVE query) would otherwise surface its last drawdown forever. After the upsert loop,
build `Set<\`${scopeType}:${scopeKey}\`>` from this run's computations and delete any
pre-existing row whose key isn't in it (`inArray` on collected stale ids). Active scopes
are re-upserted BEFORE this delete, so valid rows are never over-deleted. Reconciliation
touches ONLY the overlay table — never broker tables.

**How to apply:** any new scope type or any change to which rows the engine emits must
keep both rules; assert reconciliation in `scripts/src/fundBookBrokerOverlayTest.ts`.
