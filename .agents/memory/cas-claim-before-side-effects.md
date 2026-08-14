---
name: CAS claim before side effects in a Drizzle transaction
description: In a db.transaction, do the compare-and-swap status claim BEFORE any other write, because a plain return commits.
---

In a Drizzle `db.transaction(async (tx) => {...})`, the transaction only rolls
back when the callback **throws**. A plain `return { ok: false, reason }` from
inside the callback **commits** everything written so far.

**Rule:** when a transaction guards a mutation with a CAS (e.g.
`transitionChangeStatus(... WHERE status='RECOMMENDED')` and a rowcount/returning
check), perform the CAS claim FIRST, then the side-effecting writes. If the CAS
loses the race it updates 0 rows and you can plain-return the conflict having
written nothing.

**Why:** the AACI learning approve/rollback originally did the weight `UPDATE`
before the CAS, then `return {ok:false,'NOT_PENDING'}` on a lost race. Two
concurrent approvals could both pass the read-time status guard, both write the
weight, and the loser's weight write still committed while it reported a 409 —
double application + audit/state divergence.

**How to apply:** any "approve/apply/rollback once" transaction = CAS-claim the
lifecycle row first, branch out on failure with no prior writes, then mutate +
audit. Don't rely on an earlier `if (row.status !== X) return` read check for
concurrency — it is not atomic. (Related: live-command-exactly-once-cas.md.)
