---
name: Security handshake consult (server-side derivation)
description: How the server consultSecurityHandshake must map real signals into the pure domain evaluator — fail-closed for admin-only actions, advisory-additive everywhere.
---

# Security handshake consult — server-side signal derivation

The pure domain evaluator (`lib/domain/src/security/handshake.ts`,
`evaluateSecurityHandshake(action, input)`) is default-deny: any required
tri-state check that is `undefined` is treated as FAIL. The server wrapper
(`artifacts/api-server/src/lib/security/handshake.ts`,
`consultSecurityHandshake`) is the ONLY place that supplies real signals.

## Rule: admin-only actions fail closed on role AND permission, not just surface

When deriving `roleAuthorized` / `actionPermissioned` for an action, branch on
`SENSITIVE_ACTIONS[action].adminOnly`:
- admin-only ⇒ require a privileged role (`OWNER`/`ADMIN`) — `isPrivileged`.
- non-admin ⇒ `authenticated` is sufficient (the authoritative per-action gate
  — 16-gate pipeline + per-user approval — runs downstream).

**Why:** an earlier version derived both as `(isPrivileged || authenticated)`
for ALL actions, so any authenticated caller looked role/permission-authorized
for an admin-only action. Even though `adminSurfaceOk` already failed closed for
non-privileged callers, relying on a single signal is fragile — a callsite that
passes `adminSurfaceOk: true` (an admin chokepoint) would have let the weak
role/permission signals through. Defense-in-depth: each signal must fail closed
independently. Architect rated the single-signal version a Fail.

**How to apply:** keep `roleAuthorized`/`actionPermissioned`/`adminSurfaceOk`
derivations action-aware and never source the override fields from raw request
input. Domain-level admin tests cover the SIGNALS (admin action + missing/false
`adminSurfaceOk` ⇒ fail); the server mapping correctness is enforced by
typecheck + the fail-closed derivation.

## Advisory-additive invariant (do not regress)

The handshake only ever ADDS a block. In the AACI hard gate
`securityHandshakePass` is an extra factor (`SECURITY_HANDSHAKE_FAILED`,
surfaced first) that can never rescue another false factor. The autonomy mapper
(`resolveSecurityAutonomyEffect`) can only REDUCE autonomy (size via `min`,
defer/downgrade). `buildAaciDecision` defaults `securityHandshakePass` to `true`
when omitted so plain advisory reads are never newly blocked; only sensitive
execution paths (e.g. `SELF_TRADE_EXECUTION`) consult it explicitly.
