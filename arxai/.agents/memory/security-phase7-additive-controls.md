---
name: Additive operational security controls (fail-safe + anti-enumeration)
description: Rules for layering operational-security caution (cooldowns, step-up, anomaly screens, operational mode) on top of existing auth/16-gate paths without weakening or leaking.
---

# Additive operational security controls

New operational-security controls ADD caution on top of the existing
auth/authz/16-gate/Risk Governor paths. They must never replace or weaken a gate.

## Action-sensitive fail handling (NOT blanket fail-open)
A durable rate-limit/cooldown service must NOT fail-open for every action on a
persistence error. Only **public anti-enumeration auth** paths (login / forgot /
reset / invite / request-access) may fail-open. EVERY sensitive action — admin,
trade, retry, assistant — must fail **CLOSED** (return blocked) so an outage
cannot become a control bypass.
**Why:** a code review flagged blanket fail-open as a real bypass for
ADMIN_ACTION / LIVE_COMMAND_RETRY / SCANNER_TO_TRADE during a DB blip.
**How to apply:** put a `failOpen: boolean` on the rate-limit RULE in the domain
policy (single source, unit-testable) — never a hardcoded set in the server.
The catch reads `rule.failOpen`.

## Repeated-failure lockout must be PRE-CHECKED
Incrementing a `*_FAILED` cooldown on a failed dangerous-action attempt does
nothing unless a future attempt CHECKS it before doing work. Add a read-only
`isCooldownActive(action, scope)` (fails CLOSED on error) and call it at the TOP
of the dangerous-admin chokepoint, before consuming the action rate limit or
evaluating step-up. Consuming the action limit is not the same as checking the
failed-lockout.

## Route step-up via a single shared chokepoint
Gate dangerous admin mutations through ONE reusable helper
(`enforceDangerousAdminAction`: failed-lockout pre-check → action rate limit →
audited step-up) so every route enforces the identical sequence. Broad rollout
across existing safety routes needs coordinated frontend confirm-phrase UIs — do
NOT bolt a confirm-phrase requirement onto an existing admin route without its
frontend, or you break the admin's ability to perform the action.

## Fail-safe, never fail-open
A `try/catch` around a NEW caution control (e.g. the self-trade trade-command
anomaly screen) must HOLD the action on error — count it BLOCKED + write an audit
event — and `continue`, NOT log-and-proceed.

**Why:** a code review caught the anomaly catch silently waving a command through
when the screen errored. "unknown ⇒ caution" means an unevaluable screen reduces
risk, never permits an unscreened command.
**How to apply:** any new additive screen wrapped in catch ⇒ block/hold + audit
(reason code like `ANOMALY_UNEVALUABLE`), then skip the side effect. The
underlying 16-gate/Risk Governor stays unchanged either way.

## Auth cooldowns must stay anti-enumerating
Durable rate-limit cooldowns on public auth (login / forgot / reset /
request-access / invite) return a **429 with the SAME neutral body** the route
already uses — never a body that reveals whether an email/invite exists.
The DB-backed `consumeRateLimit` fails OPEN (allowed:true on DB error) so a blip
never locks out legitimate users.

## Never leak cooldown scope identifiers
The admin cooldowns list endpoint must NOT return `scopeKey` even though it is a
hash. Project to action + count + timing only. Admins never need to correlate a
cooldown back to a specific IP/email/admin identity.
