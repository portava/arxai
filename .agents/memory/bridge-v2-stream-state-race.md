---
name: Bridge v2 stream-state seed-then-lock
description: Why per-stream sequence state must be seeded before SELECT FOR UPDATE, not upserted after a null-state classify.
---

# Bridge v2 per-stream state: seed-then-lock, never classify-then-upsert

When ingesting ordered EA events and tracking `lastSequence` per stream, do NOT:
read state with `SELECT ... FOR UPDATE` (which locks nothing when the row is
absent), classify against `null`, then `INSERT ... ON CONFLICT DO UPDATE`.

**Why:** two concurrent first-writes for the same stream both read a null state,
both classify as `FIRST`, and the conflicting upserts race — `lastSequence` can
rewind (e.g. 2 → 1) and the integrity counters drift. The architect flagged this
as high severity.

**How to apply:** inside the txn, FIRST `INSERT ... ON CONFLICT DO NOTHING` a
minimal seed row (PK columns only; counters default 0, lastSequence null), THEN
`SELECT ... FOR UPDATE` (now always finds + locks a row → concurrent same-stream
writers serialize on the lock), classify, insert the event (unique idempotency
key catches replays → DUPLICATE), then a PLAIN `UPDATE ... WHERE <stream>` to
advance. A plain UPDATE (not GREATEST) is correct here because RESET must be able
to re-anchor `lastSequence` downward to 0 — GREATEST would break legitimate EA
counter restarts.

**RESET semantics (deliberate):** `classifySequence` treats `incoming === 0` with
`lastSeen > 0` as RESET (EA restart). A replayed old seq=0 under a fresh
idempotency key re-anchors — acceptable for the beta kernel; a stricter rule
needs a protocol epoch field, not yet in the wire contract.
