---
name: Shared-live account provisioning (4 aligned rows + force-arm)
description: What DB rows must align to put a user on the shared LIVE master account, and how to force-arm honestly.
---

To make a user resolve to **LIVE_SHARED**, four rows must all align (the mode
resolver / account-shell reads every one — missing any single one ⇒ not live):

1. `user_trading_permissions.account_routing_override = 'shared_master_mt5'` (+ `trading_mode='LIVE'`).
2. A `virtual_trading_accounts` row: `account_type='live'`, `status='ACTIVE'`,
   `shared_master_account_id` set to the shared master.
3. A `user_slot_allocation` row (real capital; `is_active=true`, `allocation_status='active'`).
4. `arx_live_arming.is_armed = true`.

**Mirror an existing working shared user** (e.g. the owner) to get the exact
values. `shared_master_account_id` is its own id — NOT `arx_master_account_config.id`
and NOT the mt5 connection id. Copy the same value the working user points at so
all shared users attach to the one master.

**Force-arming via DB bypasses** `evaluateLiveArmingGate` (the 15-check MT5 Setup
confirmation gate). If an owner authorises it:
- Compute the canonical confirmation-phrase hash fresh — `sha256("ENABLE LIVE TRADING")`.
- **Never copy another user's `arx_live_arming` row** — it carries their personal
  `confirmation_phrase_hash` + `armed_from_ip`, and copying fabricates their identity.
- Write an HONEST `last_readiness_snapshot` marking `forceArmed/gateBypassed`
  rather than faking a `allPassed:true` 15-check record.
- Audit the bypass explicitly (`admin_action_audit_log` FORCE_ARM_LIVE +
  `master_live_access_audit`).

**Why:** real-money safety surface. Arming flips the *displayed* mode and
eligibility, but an actual live trade still has to pass all 16 dispatch gates at
trade time (heartbeat ≤15s, EA connected, lot/loss caps, SL present, etc.), so
force-arming makes a user *eligible*, it does not place anything and bypasses no
dispatch gate.

**How to apply:** when asked to "add user X to the shared live account / set them
to live", provision all four rows in one audited transaction, mirroring a known
working shared user; confirm the financial (allocation $) and arming-bypass
decisions with the owner first — both are judgment calls you must not guess.
