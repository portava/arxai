---
name: AACI security handshake enforcement scope
description: Where/how the advisory security handshake must be enforced, and the BLOCK-only semantic.
---

The AACI security handshake (`enforceSensitiveAction`) is ADVISORY-ADDITIVE: only
a `recommendedAction === "BLOCK"` refuses; `ALERT_ADMIN`/`ALLOW` proceed. A PASS
never relaxes any other gate.

**Why:** Phase-2 integration was rejected twice in review. Blockers were (1) the
enforcement covered only a narrow set of actions, not the full
`SENSITIVE_ACTIONS` catalog, and (2) there were no action-level / no-bypass
tests. Reviewers want enforcement at the REAL service/route chokepoints, not just
the AACI decision composer.

**How to apply:**
- Enforce at concrete chokepoints, mapping each to its catalog action: live
  instant trade (LIVE_TRADE_EXECUTION/CLOSE_POSITION/MODIFY_SL_TP), self-trade
  service mutations, agent ledger fund/defund (ALLOCATE_FUNDS), and admin route
  mutations (ROTATE_BRIDGE_SECRETS/ISSUE_INVITE/APPROVE_USER/CHANGE_USER_ROLE/
  ADMIN_DIAGNOSTICS) + RESET_PASSWORD after token consume.
- Gate only the SENSITIVE direction: release (not engage) a kill switch;
  activate (not pause/stop) an agent. Protective directions are never consulted
  so a user/operator can always reduce risk.
- `DISABLE_KILL_SWITCH` is `adminOnly` in the catalog → a non-privileged caller
  hits the BLOCK class. Safe for self-trade (operator surface), but never gate a
  USER-operable protective action with an adminOnly catalog entry.
- Admin route consults pass `adminSurfaceOk: true`.
- No-bypass invariant for tests: `ok === (recommendedAction !== "BLOCK")`, every
  BLOCK carries a `SECURITY_HANDSHAKE_FAILED` reasonCode, blocked user copy is the
  constant clean message (no token/code/action leak).
