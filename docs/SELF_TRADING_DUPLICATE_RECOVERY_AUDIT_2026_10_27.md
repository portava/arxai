# Self-trading duplicate prevention, reconciliation and crash recovery: adversarial audit (2026-10-27)

Branch `claude/self-trading-idempotency`, cut from `5767ec5`. Trading, workers and settlement stay disabled. No broker, terminal or network call was made, no existing database was touched, and there is no schema migration. Every PostgreSQL test runs in a disposable Unix-socket cluster that the runner creates and deletes.

This audit covers duplicate broker commands, lost intents, double-posted P/L, hold release and cross-owner effects across the self-trade entry/management path and the shared live-command pipeline under it. It does not cover kill switches, sizing math, stale-fact revalidation or MT5 result-evidence reporting. Other work owns those areas.

## Method

Every suspicion became a test before any fix. Races run in the new disposable-PostgreSQL lane `pnpm --filter @workspace/api-server test:self-trade-duplicate-recovery-postgres`. That lane is registered in `ci:integration`. Each interleaving is forced deterministically:

1. A second connection takes the same row lock and makes the same uncommitted transition as the competing writer (a dispatch CAS, a fill, a mailbox claim, a live-commands-poll pickup).
2. The code under test starts and the test waits until `pg_stat_activity` shows it blocked on that lock, or until it finishes without blocking (proof that it never re-checked).
3. The competitor commits.

Effects on self-trading are checked by running the real `reconcileAgentExecutions` against a linked `self_trade_agent_executions` row. The tests use the real legacy mailbox handler (`GET /api/mt5/commands`). Delivery is called in-process with a fake connection object.

## Confirmed bugs and fixes

| # | Bug | Effect class | Fix | Commit |
|---|---|---|---|---|
| 1 | `cancelLiveCommand` (`lib/live/liveCommandPipeline.ts`, previously at ~5380) read the status, then updated **by command id alone**. A dispatch (`LIVE_APPROVED → SENT_TO_MT5_LIVE`, mirror queued) or a fill (`LIVE_PARTIALLY_FILLED → LIVE_FILLED`) that committed between the read and the write was overwritten with `LIVE_CANCELLED`. The exposure reservation was released. The linked self-trade entry reconciled to `BLOCKED`, so agent capacity was freed for a second order while the first stood at the broker. Six concurrent cancels of one draft produced several "successful" cancellations and audits. | (a), (b) | Update predicated on the validated status and owner. A lost race returns `LIVE_CANCEL_RACE_LOST` and releases nothing. | `d1ff45e` |
| 2 | The TTL sweep (`sweepExpiredLiveCommands`) marked a never-served entry `LIVE_EXPIRED` but left its `mt5_commands` mirror `PENDING`. The server TTL is 60 s. The v1.50/v1.54 EA's own expiry is 120 s (`CommandExpirySeconds`) and is measured with the broker clock. The legacy mailbox handler serves entry mirrors without consulting the authoritative command (`projectManagementMailbox` returns non-management rows unchanged). An order ARX had declared "never executed", with its reservation and self-trade slot already freed, was therefore still delivered to the EA. | (a), (b) | `neutralizeUndeliveredMirrors()` cancels `PENDING` mirrors in the expiring transaction. | `ebec210` |
| 3 | The sweep read the mirror status and then expired the command in a separate statement. An EA mailbox claim that committed in between was ignored, so a delivered command became `LIVE_EXPIRED`. | (b) | Expire per command in one transaction (mailbox → command lock order, the same order as the mailbox claim). A mirror that is already claimed makes the verdict `LIVE_UNKNOWN`. | `ebec210` |
| 4 | The same window existed for a `live-commands-poll` pickup: the expiry CAS checked `status = SENT_TO_MT5_LIVE` but not `picked_by_ea_at IS NULL`. | (b) | `picked_by_ea_at IS NULL` is re-checked after the row lock. A lost race rolls back the mirror cancellation, and the next sweep classifies the command `LIVE_UNKNOWN`. | `ebec210` |
| 5 | When the mirror enqueue failed, the dispatch path set `LIVE_FAILED` unconditionally and released the reservation. A mirror INSERT can commit even though its client saw an error (ambiguous commit or connection drop). The mirror then stayed `PENDING` and deliverable behind a "failed" command. | (b) | Cancel any such mirror and fail the command (status CAS) in one transaction. If a mirror may already have been delivered, or the check itself fails, leave the command `SENT` for the sweep, return `BRIDGE_ENQUEUE_OUTCOME_UNKNOWN` and keep the reservation. | `ebec210` |
| 6 | The shared-trade attribution fail-safe (`routes/tradesLiveShared.ts`) falls back to a force-block when cancel fails. That fallback updated by id alone. With fix 1, a cancel that loses the race against the alternate `/me/live/commands/:id/dispatch` route (the route the code comment names) reached this fallback, which relabelled the already-`SENT` command `LIVE_BLOCKED`. | (b) | CAS from `LIVE_APPROVED`. `commandRenderedTerminal` now reports whether it matched. | `359f9f1` |

Tests that failed before their fix: 3 for #1, 7 for #2–#5, 1 for #6. #6 is covered only by a source-order test. The route is not driven end to end. The dispatch catch in #5 is covered by direct PostgreSQL tests of `neutralizeUndeliveredMirrors` plus a source-order test that it runs before the `LIVE_FAILED` CAS. `dispatchLiveCommand` itself is not driven through its 18 gates in this lane.

Behaviour changes are limited to race outcomes:

- A cancel that loses a race now answers 409 instead of clobbering the other writer.
- An enqueue failure whose mirror may have been delivered now stays `SENT` instead of becoming `LIVE_FAILED`.
- The sweep may defer an expiry it cannot neutralise.

The existing source pins in `wave5Seam` and `executionEpistemology` still pass unchanged.

## Scenarios tried that held

The existing entry suite already covered several of these. The new lane adds guards marked †.

- Distinct decisions from concurrent cycles (24-way) admit one slot. A consumed decision is never replayed. Unknown/pending entries survive restart and UTC midnight.
- The draft and the reservation link commit together, so the "lost command-link write" class is closed for new drafts. Overlapping draft attempts yield one command (`ENTRY_ALREADY_LINKED`). Confirm and dispatch claims are CAS. Agent final claims re-validate authority under the agent lock.
- Executor crash or thrown pipeline after draft: the reservation stays `PENDING_TICKET` with the command linked, and nothing releases it by time. A returned refusal without a command id happens only before any draft exists.
- Management claims are JSONB compare-and-set. Concurrent cycles cannot claim the same state. An uncertain submission keeps its claim.
- Realized P/L posting is serialized on the agent row lock and posts once per execution (entry suite: concurrent funding + posting).
- Accounting hold (`closeAccounting`): no code path removes it, and management state writes are CAS on the full prior JSON, so a concurrent hold write cannot be lost.
- † Eight overlapping reconcile cycles count one fill and keep the broker fill time across a UTC boundary.
- † A command owned by another user never settles this user's reservation.
- † Six concurrent cancels of one draft produce exactly one cancellation.
- † Normal delivery of an unexpired mirror and the `UNKNOWN` verdict for an already-delivered mirror are unchanged.
- Settlement outbox: leases commit before consumers, completion is fenced by token, generation and expiry, and exhausted jobs are `HELD`. No path releases a hold without evidence.

## Open: suspected or known, not fixed here

1. **Dual-channel delivery has no server-side mutual exclusion.** Every dispatch writes a mailbox mirror. A `live-commands-poll` pickup does not cancel that mirror, and a mailbox claim does not stamp `picked_by_ea_at`. A command that reaches a terminal state through the arx channel (for example `LIVE_REJECTED`, or `LIVE_FAILED` from the unknown reconciler) can leave a `PENDING` mirror that the legacy mailbox still serves. In-repo EAs execute on only one channel: v1.50/v1.54 poll only the mailbox, and `ReplitMT5BridgeEA` polls both but refuses mailbox execution. A terminal that executed both channels would place the order twice. **Not reproduced. Recommended fix:** `GET /api/mt5/commands` refuses an entry mirror unless its authoritative command is `SENT_TO_MT5_LIVE` and unpicked, or every terminal transition calls `neutralizeUndeliveredMirrors`. Not changed here because the mailbox handler is shared with the mailbox-transport work.
2. **EA expiry clock (suspected, EA code, unverified).** v1.54 `HandleCommand` computes `TimeCurrent() - createdAtEpoch`. `TimeCurrent()` is broker server time, often UTC+2/+3, while `createdAtEpoch` is UTC. On positive-offset brokers every command can look expired. On negative offsets commands may never expire. The server must not rely on EA expiry, and fix #2 no longer does. Not tested against a terminal.
3. **Unknown reconciler absence verdict.** A market entry that fills and closes before a full position snapshot captures it resolves `LIVE_FAILED`. The self-trade entry then becomes `REJECTED`, capacity is freed and the P/L is never recorded. This is inherent to snapshot-only evidence.
4. **Unknown reconciler fill time.** `RESOLVE_FILLED` stamps `filledAt = now` (reconcile time), so the self-trade `filledAt`, and daily-quota attribution across UTC midnight, can use poll time.
5. **Legacy non-management close path** in `agentReconciliation.ts` still computes `realizedPnl` from the *current* per-user contract spec and account currency, and posts it. Only executions whose `closeCommandId` is not an agent-management command can reach it. That valuation can belong to a different account.
6. **Ledger idempotency is protocol-only.** `self_trade_ledger_entries` has no unique `(agent, REALIZED_PNL, EXECUTION, ref_id)` index. Exactly-once posting depends on every writer taking the agent lock, and today there is one writer. Adding the index needs a migration, which is out of scope.
7. **AACI trust lost update (advisory, not ledger).** `applyOutcomeToTrust` reads the trust row without `FOR UPDATE`. Two executions folding into the same entity concurrently can lose one update. The unique audit index does prevent the same execution being applied twice. Not tested.
8. `PENDING_TICKET` rows without a command id (a crash between reservation and draft) and claims without a command id still need the audited evidence-based repair workflow that earlier docs call for. Nothing releases them, and nothing repairs them.
9. When the sweep resolves `LIVE_UNKNOWN` because the arx channel picked the command up, it leaves any `PENDING` mirror in place (see item 1).
10. The executor's gate-`BLOCKED` insert can add a second `BLOCKED` row with an already-used decision key (the partial unique index covers active statuses only). This is cosmetic. No dispatch follows.

## Test counts (local, disposable clusters, host shared with other agents)

| Suite | Before (`5767ec5`) | After |
|---|---|---|
| `test:self-trade-duplicate-recovery-postgres` (new) | n/a (11 of the 13 fix-covering tests fail against pre-fix code) | 15/15 pass |
| `test:self-trade-entry-postgres` | 73/73 | 73/73 |
| `test:self-trade-management-postgres` | 107: 103 pass, 3 skip, 1 fail (environmental, below) | final run: 107: 104 pass, 3 skip, 0 fail (earlier loaded runs: same single environmental failure) |
| `test:self-trade-accounting-postgres` | 37: 34 pass, 3 skip | 37: 34 pass, 3 skip |
| `test:result-evidence-postgres` | not run at baseline | 32: 30 pass, 2 skip |
| `test:execution-epistemology` | 35/35 | 35/35 |
| `test:wave5-seam` | 25/25 | 25/25 |
| `test:unknown-reconciler` | 33/33 | 33/33 |
| `test:unknown-reconciler-worker` | — | 7/7 |
| `test:self-trade-lifecycle` | 44/44 | 44/44 |
| `test:ack-partial-fill` | — | 12/12 |

The occasional management failure, "actual concurrent cold-map manual polls complete with a one-connection pool", also fails at baseline under load. It is a child process that cold-starts `tsx` with an 8 s `spawnSync` timeout (`ETIMEDOUT`), and this host is shared with other agents (load average above 5). One loaded run of the whole file also hit the runner's own 60 s budget. In the final, less loaded run it passed. The skips are the optional benchmark tests.

Also run after the changes: `pnpm run typecheck:libs`, the api-server and scripts typechecks (scripts needed `--max-old-space-size=4096`; it ran out of heap at the default), and `ci:guards` with the offline `DATABASE_URL`: 87/87 guards plus 7 bridge-binding assertions. The full root `pnpm run typecheck` (every artifact) was not run.

## Autonomous-cycle coordination and bounded waits (28 October 2026)

Branch `claude/self-trading-cycle-r3` from `a89c999`. Gap closed: the run-cycle single flight was per process, and the database pool had no connection, statement or lock timeout, so two API processes could overlap cycles and one stalled wait could hold the cycle slot forever.

Design (`lib/selfTrade/cycleCoordinator.ts`): a session-level `pg_try_advisory_lock(ARX_LOCK_NS.SELF_TRADE_CYCLE, 1)` on a dedicated connection held for the cycle; the cycle re-verifies it before each decision, each agent's management and the protective drain and stops there if it is gone; the cycle's queries run on a dedicated pool with bounded waits; the response carries `completion` (`COMPLETED` / `INCOMPLETE` / `STOPPED`). A lease row with a fencing token was not chosen: it needs a migration, its TTL would have to guess how long a cycle may legitimately run, and a fence protects only writes that check it. The per-item compare-and-set claims listed above stay the backstop for the item in flight when a lock session drops.

`test:self-trade-cycle-coordination-postgres` (new, in `ci:integration`) runs each API process as a real OS process (`cycleCoordination.child.ts`, forked) serving the real route, coordinator, cycle, executor, entry authority claims, exposure reservation, reconciliation, position manager, Position Guardian and `executeInstant`. Decision generation, advisories and access gates are stand-ins; the last dispatch hop runs the production claim helpers in production order (reserve exposure, final claim, mailbox mirror) with pause points. All 11 cases failed against `a89c999` (log kept locally) and pass after the change:

- Two processes started together: one runs, the other gets 409 and never reaches the decision step; afterwards it runs and skips the consumed decision.
- SIGKILL of the lock holder at six points (entry and management: before the final claim, after the claim, after the mailbox mirror): the lock frees; the next cycle in another process creates no second command or mirror for that decision or management action; a fresh decision for the same agent is refused by the occupied slot; the killed entry keeps its `RESERVED` exposure row and its `PENDING_TICKET` / `DISPATCHED` reservation; the management claim is retained; no command becomes filled, expired, cancelled or failed.
- `lock_timeout` and `statement_timeout` (400 ms) on a final claim whose command row another connection holds: the cycle answers while the row is still locked, the claim and its audit roll back, the reservation is kept, `completion` is `INCOMPLETE` with the timeout counted, the lock is free, and the next cycle completes without a duplicate.
- Pool of 2 exhausted mid-cycle with a 300 ms acquisition timeout: `INCOMPLETE` with the failed agents and timeouts counted; a run while still exhausted answers `500 CYCLE_FAILED` within the bound and dispatches nothing; once connections return, the next cycle completes once.
- Lock session terminated (`pg_terminate_backend`) mid-cycle: another process takes the lock and runs; the first resumes, stops before its first dispatch, reports `STOPPED` / `LEASE_LOST` and recovers for its next run.

Review fixes (same day), 7 more cases (18 in all); the half-open and pooler cases failed against `b00df77` (the pooler ones partly because it had no statement-routing seam), and the two new safe-point cases fail when the agent-loop and pre-drain checks are deleted (logs kept locally):

- Lock lost between agents (after agent 1's reconciliation): agent 4 is not managed (`agentsNotStarted` 1, no management command); the next run manages it once. Lock lost after the last agent with a queued (stand-in) protective candidate: the drain does not run (`protectiveNotRun` 1).
- A cycle connection that goes silent mid-query (loopback proxy stops forwarding, no reset): `500 CYCLE_FAILED` "database wait exceeded" within the client read bound, both locks free, nothing dispatched, the silent connection is discarded and the next run completes once. A lock connection that goes silent during acquisition: `500` "No cycle was started" within the lock-query bound.
- Transaction-mode pooler, simulated by routing the coordinator's statements to chosen server sessions: a session already holding the lock (re-entrant) is refused without a second grant; verification on another session refuses and unlocks only on the session that took the lock (if the unlock lands elsewhere, the lock stays on the pooled session and later runs get 409, as documented); a lease whose check lands on another session is lost.
- Offline (`autonomousCycleReport.test.ts`): a lost connection (57P01/57P02/57P03, 08xxx, "Connection terminated unexpectedly") or an unproven protective hold makes `completion` `INCOMPLETE`, counted in `dbConnectionFailures`.

Still not covered: a lock session that drops while one item is mid-dispatch (that item finishes; its own claims prevent a duplicate, but the cycle notices only at the next safe point); the protective drain's 20 s wait is not interrupted by a lost lock; non-database awaits (guardian, AACI services) remain unbounded; a half-open lock connection is noticed by the server only through TCP keepalive (10 s delay plus the OS probe interval and count), and until then other processes are refused (safe direction); a half-open work connection that the client dropped can keep its server-side transaction, and its row locks, until `idle_in_transaction_session_timeout` (60 s) or server keepalive; the lock requires a direct or session-mode connection (a transaction-mode pooler is detected and refused, not supported; no real PgBouncer was run); the real `dispatchLiveCommand` and the real decision engine are not driven in this lane: the timeout and SIGKILL cases run a stand-in hand-off with the production claim helpers, so `dispatchLiveCommand`'s own catch branches (LIVE_BLOCKED CAS + release, bridge-failure neutralise + release, RACE_LOST release) are covered under real timeouts by no test, only by the existing injected-error and source-order tests (by reading the code: under `lock_timeout` its outer-catch LIVE_BLOCKED CAS waits on the same locked row and also times out, so it throws without releasing the reservation); no broker, terminal or EA.

## Not verified

- No live/demo broker, terminal or EA behaviour, including EA expiry (item 2) and dual-channel execution (item 1).
- `dispatchLiveCommand`'s enqueue-failure branch and the shared-trade route are verified by source order plus helper-level PostgreSQL tests, not end to end.
- Mixed-version rollout: older servers running the previous sweep do not neutralise mirrors.
