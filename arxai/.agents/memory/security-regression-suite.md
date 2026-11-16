---
name: Security regression suite invariants
description: Durable pitfalls when writing a consolidated security regression suite that mints test users and asserts no-leak / no-live-dispatch.
---

# Security regression suite invariants

ARX's consolidated security suite (grep `securityRegressionSuite`) is
real-evidence only: mint USER/USER/ADMIN, log in through the real proxy,
exercise pure-domain evaluators, clean up in `finally`. The durable pitfalls
below are what bite when you write such a suite — not recoverable from the code.

## Strict-zero on a persistent evidence table = baseline-delta, never ==0
- **Rule:** `arx_live_commands` is a persistent SAFETY-EVIDENCE table. The
  owner/admin controlled-live-testing environment legitimately holds historical
  rows that must NEVER be deleted. Assert the suite *creates* nothing live via
  baseline-delta (`start === end`) AND per-seeded-user attribution
  (`WHERE user_id = ANY(seededIds)` === 0) — not a whole-table `count == 0`.
- **Why:** `==0` would fail CI forever or pressure you to delete real evidence.
  **How to apply:** any test touching a persistent evidence/audit table.

## Leak-scan must exclude the one legitimate one-time secret reveal
- **Rule:** a secret that is *designed* to appear exactly once (e.g. the raw MT5
  bridge token in the connection-creation response) must be excluded from the
  secret-leak blob, or the leak check false-fails on correct behavior.
- **How to apply:** verify the one-time reveal separately (present at creation,
  absent from every subsequent read/list); leak-scan only the other payloads.
- **Honesty caveat:** scope leak-check claims to the surfaces actually scanned.
  This suite scans client payloads + REAL admin export endpoints + REAL
  persisted admin_action_audit_log rows via one shared `scanSecretValues()`
  (value-based: passwords, rawBridge, `scrypt$`, env-secret values); field-name
  heuristics (`password.?hash`, `apiKeyHash`) apply to client payloads only.
  LOGS + EMAIL are now also covered (04e/04f): logs via the exact domain
  `redactForLog`/`redactSecretString` the server's `secureLog` delegates to (feed
  real secrets, assert none survive, non-secrets kept); email via a PURE domain
  body builder (`@workspace/domain/email` buildPasswordResetEmail) the api-server
  sends verbatim — password-reset is the ONLY real outbound email (alert/invite
  hooks are no-ops). Test email by extracting templating to a lib so the rendered
  body is importable; keep IO (Resend transport) in the artifact.

## camelCase keys slip past boundary-anchored redaction patterns
- **Rule:** the domain redaction engine's key patterns are boundary-anchored
  (e.g. `/(^|[_\-.])secret([_\-.]|$)/i`), so a camelCase compound key like
  `sessionSecret` does NOT match while snake `session_secret` does — and the
  api-server audit redactor (plain-substring regex) caught it, so only the LOG
  path leaked. Fix is additive: `isSensitiveKey` tests BOTH the raw key and a
  camelCase-split form (`replace(/([a-z0-9])([A-Z])/g,"$1_$2")`). Strictly
  redacts more, never less.
- **How to apply:** when proving "secrets don't reach logs," feed a camelCase
  secret key (not just snake) — that is what exposes this class of gap.

## Prefer real-endpoint evidence over a pure-rule test where it's safe
- **Rule:** a domain-evaluator test proves the algorithm but NOT that the route
  is wired to it. Where hammering a real endpoint is side-effect-safe, add it.
  For invite rate-limit: the gate is ON, so invalid codes return 403
  INVITE_NOT_FOUND and never create an account — safe to hammer `/api/auth/register`
  until HTTP 429. Assert firstStatus∈{403,429} (a 200/201 would mean the gate is
  off and you created an account — a real failure, not a pass).
- **Why:** review flagged "domain-only" checks as not proving runtime wiring.

## Real auth-endpoint hammering pollutes a per-IP cooldown — reset YOUR scope, not a time-window
- **Rule:** any suite that logs in / hammers auth endpoints from loopback shares
  ONE per-IP `security_cooldowns` scope (`ip:` + sha256(req.ip).slice(0,24)).
  Across repeated runs LOGIN/INVITE_CODE_ATTEMPT counts accumulate and 429 the
  suite's OWN admin login (flaky, not a code bug). Fix: at the START of the run
  delete cooldowns ONLY for the harness's own loopback scope keys (compute
  hashScope for 127.0.0.1 / ::1 / ::ffff:127.0.0.1 / "unknown"). req.ip behind
  the proxy is `127.0.0.1` here.
- **Why:** a broad `DELETE … WHERE updated_at > now()-interval` erases OTHER
  scopes' live rate-limit state (non-hermetic; review-blocking). Scoping to the
  loopback key never matches a real remote user and weakens no rule.
- **How to apply:** replicate the 2-line hashScope locally (cross-artifact import
  is disallowed); reset at start (self-correcting), not finally.

## Test-user cleanup must be fail-closed, not a hand-maintained list
- **Rule:** swallowing delete errors (`.catch(()=>{})`) over a hand-listed set
  of tables silently leaks rows when a new FK child table is added. Instead
  discover every public table with a `user_id` column, delete seeded rows there
  first (FK-safe), delete users by id, then assert zero seeded users remain so
  the run FAILS on any leak.
- **Why:** "cleanup ran" ≠ "cleanup succeeded"; only post-verification proves it.
