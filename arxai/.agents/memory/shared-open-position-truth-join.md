---
name: Shared open-position truth requires a user-scoped JOIN
description: How the ARX Allocation "Open positions" view stays phantom-free and tenant-safe
---

The "Open positions" surface for a SHARED_MASTER user must be the INNER JOIN of
`shared_trade_attribution` (status='open', ticket NOT NULL/'') ⋈
`arx_live_positions` on the broker ticket — never attribution rows alone.

**Why:** attribution is flipped to status='open' on dispatch-to-bridge
(disp.ok), not on a confirmed fill; an EA rejection never flips it back, so an
unconfirmed-open phantom (null ticket/entry/opened) lingers. Gating on a real
`arx_live_positions` row (closed_at IS NULL AND reconcile_state IS NULL) is the
only honest "is this actually open at the broker" signal.

**How to apply:**
- The JOIN MUST be scoped by user: `arx_live_positions` uniqueness is
  `(user_id, broker_ticket)`, NOT global. Joining on ticket alone lets a shared
  ticket string cross-join another user's live position. Always add
  `arx_live_positions.user_id = shared_trade_attribution.user_id` to the ON.
- Allocation/exposure math (`getUserAllocationView` openFloatingLoss) must add
  `reconcile_state IS NULL` so reconciled/orphan rows never drag availability.
- Phantoms are cleaned by the idempotent audited reconcile script
  (status→'reconciled', writes admin_action_audit_log) — never by deleting rows.
- The dispatch-time optimistic "open" label was intentionally left in place; the
  ticket-gate everywhere makes it harmless and the reconcile sweeps it.
