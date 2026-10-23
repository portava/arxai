---
name: Phantom open-position cards need a confirmed broker ticket
description: Why a "live position" card/count must be gated on a real broker ticket, and how to reconcile orphan attribution rows without touching in-flight commands.
---

A Shared-Master attribution row (or a user-owned live position row) must NOT be
rendered as an open "live position" card — or counted in open exposure — unless it
carries a CONFIRMED broker identifier: `shared_trade_attribution.mt5_position_ticket`
(SHARED_MASTER) / `live_positions.broker_position_id` (USER_OWNED), present AND
non-empty. A row in `status='open'` with a NULL/empty ticket is phantom: it shows
forever as "Waiting for MT5 sync" because no MT5 execution ever happened.

**Why:** The open-trades read once rendered any `status='open'` attribution row as a
card regardless of ticket. Real fills travel a SEPARATE Phase B path
(`arx_live_commands`), so unconfirmed/rejected attribution rows (e.g. EA returned
`EA_READ_ONLY_MODE_ACTIVE`, or an OPEN that never dispatched) leaked into the UI as
fake open positions and dragged availableAllocation/openCount.

**How to apply:**
- Display + summary (`/me/trades/open`, `/me/trades/summary`) gate BOTH routing
  branches on the confirmed-ticket predicate. Never show/count a no-ticket open.
- Orphan cleanup (`reconcileOrphanSharedAttributions.ts`) is a LEDGER correction
  only — it sends NO broker/EA command (there is no ticket to close) and never
  fabricates a ticket. Eligibility is deliberately NARROW:
  - `status='open'` + no ticket → ALWAYS reconcile (definitionally phantom).
  - `status='pending'` + no ticket → reconcile ONLY when the order is no longer in
    flight: no linked command, command row missing, linked `mt5_commands.status`
    NOT in the in-flight set {PENDING, DELIVERED, DEMO_APPROVED, SENT_TO_MT5_DEMO,
    SENT_TO_MT5_LIVE}, OR the row is older than a staleness threshold (~30 min).
    A recent in-flight pending is PROTECTED — reconciling it would hide a real fill
    that arrives moments later.
- Script defaults to DRY-RUN; mutation requires `--apply`; supports `--user=<id>`
  scope; writes a fail-closed `admin_action_audit_log` row in the SAME transaction
  as each guarded UPDATE (which re-asserts open/pending + no-ticket at write time).
- The pure eligibility helper is exported and shared with the regression test so the
  rule cannot drift between implementation and test.
