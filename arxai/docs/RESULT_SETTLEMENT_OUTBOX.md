# Durable server settlement recovery

Status: offline implementation; migration prepared, not applied to any shared or external database. Background recovery defaults **OFF**. No broker execution, deployment, or terminal delivery change.

## Problem and acceptance

An atomic accepted result receipt can survive a server crash while its later exposure/position update has not run. Retrying the HTTP report can repair that work, but a terminal that never retries leaves it pending. This change records the existing authorized settlement intent in the receipt transaction and supports an explicitly enabled server recovery worker.

Required invariants:

- Outcome, immutable report evidence, critical audit chain, and required recovery intents commit together. Missing schema or failed enqueue rolls all of them back.
- Identical retries do not append evidence or reset a hold/retry budget. Distinct contradictions remain evidence and do not replace accepted authority.
- Only the allowlist below executes. No broker or Guardian dispatch, order submission, advisory replay, fabricated terminal identity, or inferred realized profit.
- A new accepted cumulative result can supersede earlier settlement intent. Every accepted report remains in immutable execution events. This is latest-state reconciliation, **not one delivery per report**.
- Leases commit before consumer locks. Stale generation/token/expired lease cannot mutate a newer job or certify completion. The consumer rechecks current receipt, owner and target under its existing locks before changes.
- Crash after receipt, after lease, or after position application can recover without another broker report. Application remains idempotent. Partial/full reports, snapshots, reused tickets and ownership changes cannot shrink or close another position.
- Unknown evidence and exhausted retries stay HELD. Time never resolves them. A reviewed recovery mechanism/evidence repair is required; this slice does not ship a manual “resolve” endpoint.
- The existing local p95 budget remains 100 ms for measured server receipt/response/settlement work. Measure old/current against the identical real pool and equivalent fixtures, retain failed samples and p99/max. No broker/production speed claim follows.

## Design and state

`result_settlement_jobs` has one row per owned command and allowlisted consumer. It stores the accepted receipt fingerprint, monotone generation, status, attempts, due time, lease token/expiry, reason and completed generation. Immutable execution events retain previous accepted and contradictory receipts; this small mutable table represents unfinished state reconciliation.

New APPLIED evidence atomically inserts or advances an intent to PENDING. It invalidates any prior lease, resets the attempt budget for the new evidence, and retains the older completed generation as historical context. Exact retries and retained contradictions do not reset generation or HELD.

`PENDING/RETRY → LEASED → DONE | HELD | RETRY`. An expired lease can be claimed again; an expired eighth attempt becomes HELD. Each claim increments attempts exactly once. Backoff is bounded exponential delay with deterministic per-job/generation jitter, 0.8–60 seconds. Eight attempts maximum. A pass claims at most 16 jobs, sequentially, with non-overlapping intervals. Exhausted-lease cleanup is also bounded to 16 rows per claim. No unbounded in-memory work queue exists.

Claim transactions use `FOR UPDATE SKIP LOCKED` and commit before running a consumer. Consumer order remains manual `position → command → job`, automatic `agent → execution → entry command → position → management command → job`, and exposure `command → job → reservation`. Lease-only transactions never wait for a command/position/agent. Existing exposure admission inserts a reservation under its advisory master/user lock and does not hold a reservation row while acquiring a command. Consumer changes happen before the separate token/generation/expiry-fenced completion write. A crash in that gap replays the idempotent consumer. If the lease expires after consumer commit, the stale completion returns false and cannot certify DONE; the next owner rechecks evidence and applies the idempotent consumer before completing its own fenced claim.

## Exact consumer allowlist

| Consumer | Permitted work | Required evidence / refusal |
|---|---|---|
| EXPOSURE_RESERVATION | Existing RESERVED → FULFILLED/RELEASED status rule | Reread owned current command and accepted receipt in one transaction; only matching-owner reservations; unconfirmed outcome or contradictory settled state stays HELD |
| MANUAL_CLOSE_POSITION | Existing signed-basis cumulative close application and marker | Current accepted receipt, signed target, exact row identity, local revision/epoch and bounded cumulative volume; snapshot/legacy ambiguity stays HELD |
| AGENT_CLOSE_POSITION | Existing signed management full-close application | Exact owner/entry/account/position target and current accepted full-close evidence; whole-agent accounting hold preserved |

Manual Mission close recording remains an advisory callback only for a newly applied synchronous close. The worker never replays it. Failure-streak callbacks, broad ghost cleanup, agent profit posting, broker-account certification and any order dispatch are excluded. The current terminal's absent execution identity remains unverified, not silently “matched.”

## Deployment and operational truth

Prepare/apply `lib/db/migrations/2026-10-26_result_settlement_outbox.sql` **before releasing this application code**. No migration has been executed externally. The additive migration creates constraints/indexes and never backfills historical work. If missing, result recording fails/rolls back rather than acknowledging recovery work that was not persisted. Rolling back application code can leave the additive table intact, but older code does not maintain this recovery guarantee.

The startup wrapper does no DB work or processing while `ARX_RESULT_SETTLEMENT_WORKER_ENABLED` is absent or anything except the exact string `true`. Explicit enablement performs a read-only schema probe, then starts a five-second non-overlapping interval. No environment flag was changed in this work. A failed schema probe leaves recovery disabled. Stop fences a delayed probe and prevents new cycles; an executing consumer retains its lease/fencing semantics.

The normal request still makes a bounded synchronous settlement attempt. Responses distinguish `receiptPersisted` from `positionSettlement` (APPLIED/HELD/PENDING/NOT_APPLICABLE) and `settlementRecovery`: latest accepted command state, per-consumer generation/status/reason, pending/held flags and configured worker enablement. Configured enablement is not proof that a worker is healthy. With the worker OFF, a crash leaves work durable but not automatically progressing; a due exact HTTP retry can retry eligible work. HELD never retries merely because another duplicate arrives.

Pre-upgrade exact retries without versioned outbox evidence create `LEGACY_RECEIPT_REQUIRES_REVIEW` holds. No startup scan infers old work. New accepted evidence from an older partial state still passes the existing conservative legacy partial/basis checks. There is no silent legacy migration into runnable intents.

## Remaining limits

- This is a server settlement outbox, not an EA result-delivery outbox. Results never received by the server remain outside its protection; overload 503 before receipt is still not acceptance.
- HELD recovery requires reviewed evidence/manual remediation; this change supplies no new authority to mark it resolved.
- Existing unknown-command reconciliation and agent lifecycle reconciliation are separate mechanisms. This worker does not claim they or the advisory Mission callback are durably completed.
- Historical actual MT5 account/session identity and realized P/L certification remain unresolved. Existing accounting holds remain necessary.
- The preexisting unbound legacy manual ticket-only ghost path and advisory Mission floating-P/L-as-realized-P/L limitation remain outside this change. New recovery only uses signed conservative consumers.
- Manual ticket-only candidate selection may conservatively hold on the wrong candidate when tickets repeat; it cannot use this worker to choose or mutate the other account. This slice preserves manual behavior rather than claiming composite identity schema completion.

## Sources and rationale

AWS documents the [transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): state and durable intent share a transaction, and duplicate delivery still requires idempotent consumers. PostgreSQL documents [SKIP LOCKED queue use and its inconsistent-view limitation](https://www.postgresql.org/docs/current/sql-select.html) and [row-lock/transaction lifetime](https://www.postgresql.org/docs/current/explicit-locking.html). Hence the queue claim is a scheduling primitive; current locked domain evidence remains authority. MetaQuotes documents [trade-transaction arrival/order and bounded terminal event queue](https://www.mql5.com/en/docs/event_handlers/ontradetransaction); a receipt sequence is server observation order, not proof of broker event order or terminal delivery.

## Validation

Disposable Unix-socket PostgreSQL fixtures execute the real receipt/audit chain and migration, real exposure/position consumers, real fencing/CAS, and a fresh-process recovery run. External fetch is rejected. Position fixtures retain mocked upstream trade dispatch and advisory Mission delivery; no actual broker/EA/production integration is claimed. The paired timing evidence is retained in `/Users/areyouok/arx-tier1-release/result-settlement-outbox-20261026/`. Previous source is frozen `248bbc410510c078c40cc11f7cf918c0a1337aa5`. Both versions use the identical actual DB/pool and actual exposure queries; no queries or transactions are mocked. Mission advisory callbacks alone are stubbed in the manual fixture.

| Local fixture / p95 | Previous | Current |
|---|---:|---:|
| 32 distinct reports: every receipt durable | 94.877 ms | 95.765 ms |
| 32 reports + 4 independent: every receipt durable | 111.341 ms | **123.749 ms** |
| 32 reports: exposure settlement observed | 9.724 ms | 15.565 ms |
| Mixed 32 + 4: exposure settlement observed | 17.293 ms | 28.219 ms |
| Sequential manual actual position completion | 11.733 ms | 12.279 ms |
| Eight identical manual reports: position completion | 10.704 ms | 17.404 ms |

The mixed-load receipt p95 fails the unchanged 100 ms target in both versions and regresses in this candidate. Current mixed-load receipt p99/max is 146.934 ms; it remains in the receipt. This change improves recovery correctness, **not measured speed**. The manual fixtures pass the 100 ms local p95 target. All receipt and position checks in the timed workloads passed. Individual response, independently observed receipt, and independently observed settlement/position distributions—including median/p95/p99/max—are stored separately. Earlier failed114.935/126.176 ms evidence from prior slices is also preserved; it is not an apples-to-apples speed comparison for this change.

Source checks and final counts are recorded in the final receipt. No remote CI run is claimed; existing integration-lane registration executes these disposable fixtures locally.

Final correctness: **30 result/outbox PostgreSQL + 86 management PostgreSQL + 73 entry PostgreSQL + 35 focused assertions**, library/API types and 87 guards pass. The final API production build is recorded in the receipt. Optional earlier benchmarks are reused from their saved receipts, not rerun as ordinary correctness.

Measurement source delta: the timed candidate preceded two final edge corrections: a skipped enqueue with a conflicting job owner now rolls back the receipt, and known manual identity/application-evidence exceptions become durable HELD directly. The benchmark's normal insert/update/receipt/consumer SQL is unchanged. Added negative tests cover both; the first paired results are retained without claiming an exact-final-source repeat.
