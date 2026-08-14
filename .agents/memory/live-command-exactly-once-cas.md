---
name: Live command exactly-once via CAS
description: Why arx_live_commands result/state writes must be CAS-guarded on the prior status, not unconditional updates.
---

# Live command exactly-once via CAS

Any write that transitions an `arx_live_commands` row to a terminal state
(LIVE_FILLED / LIVE_REJECTED / LIVE_FAILED / LIVE_EXPIRED) MUST be a single
atomic `UPDATE ... WHERE commandId = ? AND status = 'SENT_TO_MT5_LIVE'` and then
check the returned row count. If 0 rows came back, re-read the row and treat the
post as a duplicate (DUPLICATE_IGNORED) — never overwrite the outcome that won.

**Why:** A read (loadOwned) followed by an unconditional
`UPDATE ... WHERE commandId` is race-prone. Two concurrent EA result posts, or a
result post racing the TTL sweep (`sweepExpiredLiveCommands`), can both observe
`status='SENT_TO_MT5_LIVE'` and both apply different terminal outcomes
(e.g. FILLED then REJECTED, or FILLED overwriting an already-swept LIVE_EXPIRED).
That defeats both "fire exactly once" and "never go stale". Caught in code review.

**How to apply:** In `recordLiveCommandResult` (and any future state-mutating
live-command writer) put the prior-status predicate in the WHERE clause, not just
the commandId. The status guard is the concurrency primitive — Postgres makes the
guarded UPDATE atomic, so no advisory lock or transaction is needed. The duplicate
re-ack path (already-terminal at read time) and the lost-CAS-race path should both
return `{ ok: true, reason: "DUPLICATE_IGNORED" }` so the EA stops retrying.

**Testing constraint:** Reliability tasks are often forbidden from inserting rows
into `arx_live_commands` (it is an append-only safety-evidence audit table). When
that constraint holds, unit-test the *pure* helpers
(computeLiveExpiry / isLiveCommandStale / isTerminalLiveStatus /
findGhostClosedPositionIds) instead of driving real rows; defer the true DB-level
concurrency proof to a follow-up that uses an isolated/throwaway fixture.
