---
name: OWNER safety-bypass pattern
description: Design rule for any "OWNER-can-bypass-X" code in ARX live-trading routes. Failing this pattern produces a leaky guard that non-OWNERS can ride.
---

When adding any OWNER-only bypass that softens a hard ARX safety check (routing, risk caps, etc.), the bypass MUST satisfy ALL of these or it is not safe:

1. **Double identity guard.** Require BOTH `getUserRiskProfile(userId).isOwnerUnrestricted === true` AND `isOwnerRole(userId) === true`. The first flag alone is not enough — an ADMIN can explicitly assign the "Owner Unrestricted Live" template to any user, which sets `isOwnerUnrestricted=true` for a non-OWNER. Only `isOwnerRole` enforces strict bootstrapped-OWNER identity (role=OWNER OR user_id=4).

2. **Soft-reason allowlist.** Only bypass documented soft/normalisation failures (e.g. casing mismatches). Hard policy blocks — `NO_GLOBAL_SETTINGS`, `SHARED_LIVE_MASTER_NOT_CONFIGURED`, `SHARED_LIVE_TRADING_NOT_EXPLICITLY_ENABLED`, type mismatches, `*_INACTIVE`, `USER_OWNED_*` — must remain blocking even for OWNER. Encode the set as a named `ReadonlySet<string>` so reviewers can audit it.

3. **Anchor on current global config, not arbitrary rows.** A read-only DB fallback must pin to the currently-active configuration (e.g. `global_trading_settings.shared_live_connection_id`) and walk forward from there. A bare `limit(1)` on the user's rows can pick up stale or unrelated data.

4. **Read-only.** Never `INSERT` from a bypass path. Get-or-create infrastructure belongs in the strict resolver/setup flow, not in a recovery branch.

5. **Audit both outcomes.** Emit success (`*_FALLBACK_USED`) AND failure (`*_FALLBACK_FAILED`) so operators see when the bypass fired and when it tried-but-couldn't.

6. **Downstream gates must still run.** The bypass only recovers routing IDs / soft inputs — the 16-gate Phase B evaluator, kill switch, master switch, EA heartbeat, broker accept, and audit logging are re-checked at dispatch and remain in force.

**Why:** the routing resolver's `virtual_trading_accounts.status !== "active"` case-sensitivity check fired on legitimate `'ACTIVE'` rows and blocked the bootstrapped OWNER. The naive fix ("if OWNER, skip the check") leaks to anyone holding the unrestricted template and can synthesize stale routing tuples. The six-rule pattern above keeps the fix tightly scoped.

**How to apply:** any new route handler that gates on OWNER (in `artifacts/api-server/src/routes/`) should follow this shape. Search for `tryResolveOwnerSharedRouting` for the canonical implementation; mirror the structure (anchor → match → constrain user row → audit) rather than rolling a new shortcut.
