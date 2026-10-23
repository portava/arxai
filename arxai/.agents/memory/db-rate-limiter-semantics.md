---
name: DB-backed rate-limiter semantics & concurrency
description: How consumeRateLimit / evaluateRateLimit compute retryAfterMs and serialize, and the failOpen rule — when moving an in-memory throttle to the durable limiter.
---

The durable rate limiter is `consumeRateLimit(action, scopeKey, {rule?})` in
`artifacts/api-server/src/lib/security/cooldowns.ts`, composing the PURE
`evaluateRateLimit` engine in `lib/domain/src/security/rateLimit.ts` with a
`security_cooldowns` row per `(actionKey, scopeKey)`. Actions + default rules live
in `lib/domain/src/security/operationalPolicies.ts`.

**retryAfterMs on a violation is the FULL `cooldownMs`, not the remaining window.**
On exceeding `limit`, the engine sets `blockedUntil = now + cooldownMs` and returns
`retryAfterMs = cooldownMs`; while already locked it returns `blockedUntil - now`
(decreasing). It does NOT return `windowStartedAt + windowMs - now`. So a per-user
"one action per N seconds" throttle is best expressed as
`{ limit:1, windowMs:N, cooldownMs:N }` — a violating attempt during the window
locks for a fresh N seconds. **Why honest:** this never under-promises the wait
(telling a user "1s" then re-blocking would be worse). If a UI needs true
remaining-window countdown semantics, that requires evolving the shared engine
(affects EVERY action) — do not hack it per-action.

**failOpen MUST be `false` for any non-public-auth action.** `scripts/src/securityPhase7Test.ts`
asserts every action whose key is NOT in
`{LOGIN, FORGOT_PASSWORD, RESET_PASSWORD, INVITE_CODE_ATTEMPT, REQUEST_ACCESS}`
has `failOpen === false` (DB error ⇒ fail CLOSED = honest 429). Adding a new
RateLimitedAction with `failOpen:true` breaks that guard.

**Concurrency:** `consumeRateLimit` does `SELECT → evaluate → INSERT…ON CONFLICT
UPDATE` in a plain transaction with NO per-`(action,scope)` lock (no
`pg_advisory_xact_lock` / `FOR UPDATE`). Two simultaneous FIRST hits for the same
scope can both read no row and both be allowed. This is a property of the shared
primitive (used by auth/admin/ruby), not of any one caller — still strictly better
than a per-process in-memory Map (which shares nothing across instances). Treat
exactly-once-under-concurrency as a shared-limiter hardening item, not something to
bolt onto one route.

**How to apply:** to make an in-memory per-user throttle durable, add a
RateLimitedAction + rule (failOpen:false) and call
`consumeRateLimit(ACTION, hashScope(prefix, String(userId)))`; keep the route's 429
envelope byte-identical for any frontend reading `retryAfterMs`. After editing the
domain policy, run `pnpm run typecheck:libs` so api-server sees the new union member.
