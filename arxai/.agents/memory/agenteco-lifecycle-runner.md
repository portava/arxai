---
name: Agent Ecosystem background lifecycle runner
description: Phase 6 advisory/shadow interval runner — guard order, opt-in, TTL-aware live defer, and the stale-live-command freeze trap.
---

# Agent Ecosystem lifecycle runner (Phase 6)

A background interval runner that drives the advisory lifecycle engines
(outcome scoring, promotion board recommend-only, household report, immune scan)
on a schedule. ADVISORY/SHADOW ONLY — never trades, never queues a command,
never touches the 16-gate live pipeline.

## Guard order (inviolable)
opt-in enabled switch → live-in-flight defer → single-flight advisory lock →
fail-soft steps. Admin `force` (run-now) bypasses **only** the enabled switch —
never the live defer, never the lock.

**Why:** the runner must be incapable of contending with or slowing a real live
execution, even on an explicit admin trigger.

## TTL-aware live-in-flight defer (key decision)
The "is a live command in flight?" probe defers only when an `arx_live_commands`
row is `SENT_TO_MT5_LIVE` **AND** (`expiresAt` is null OR `expiresAt` is in the
future). A row past its `expiresAt` is NOT treated as in-flight.

**Why:** by the command-lifecycle TTL contract, a command past `expiresAt` can no
longer fire (EA refuses it `STALE_COMMAND_REJECTED`; server sweeps it to
`LIVE_EXPIRED`). Stale, expired `SENT_TO_MT5_LIVE` rows that the watchdog never
swept will otherwise **permanently freeze** the runner — observed in dev with 3
two-day-expired rows. Null expiry still defers (conservative).

**How to apply:** never widen this to ignore live rows by status alone, and never
DELETE live-command rows to "unstick" the runner — they are safety evidence.
Respect the TTL instead.

## Single-flight
`withTxAdvisoryLock(ARX_LOCK_NS.AGENT_ECO_RUNNER, 1, …)` — a non-blocking
xact advisory lock. Two concurrent sweeps ⇒ exactly one runs, the other returns
`skipped: "LOCKED"`. Prevents an overlapping interval + run-now (or two server
instances) from double-processing.

## Honest partial
Does **not** auto-advance Learning Camps to FULL_RETURN (full authority) — that
needs real observed-improvement evidence and stays admin-only. The runner can
only OPEN camps via the promotion board, never grant authority back.

## Opt-in / off by default
`agent_ecosystem_settings.background_runner_enabled` default false. The interval
ticks from boot but does no work until an admin enables it via the
`runner-settings` endpoint. `setBackgroundRunnerEnabled` accepts `number | null`
updatedByUserId (null = system/test caller).
